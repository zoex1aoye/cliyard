/**
 * cliyardd HTTP transport (P2a): the read-only Control API server.
 *
 * `startControlApiDaemon` is the HTTP counterpart of `startDaemon` in
 * `core.ts`: it opens the same store-backed single-instance lease, binds the
 * same loopback address, and reuses {@link CliyardDaemon} for graceful
 * shutdown, but serves `node:http` requests instead of closing the socket.
 *
 * Only `127.0.0.1` is reachable. There is no authentication, no action
 * endpoint and no SSE; the three GET endpoints live in `api.ts`. The HTTP
 * transport adds no state of its own: reads rebuild a process-local projection
 * and the only durable write remains the daemon lease acquired by core.
 */
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { Server as NetServer, Socket } from "node:net";
import { hostname as osHostname } from "node:os";
import { resolve } from "node:path";
import { createControlApiHandler } from "./api.js";
import {
  CliyardDaemon,
  DAEMON_CONTROL_HOST,
  DaemonError,
  openDaemonStore,
  readProcessStartIdentity,
  type DaemonAddress,
  type DaemonInfo,
  type DaemonLeaseRecord,
  type DaemonStoreHandle,
} from "./core.js";

export interface StartControlApiDaemonOptions {
  repoRoot: string;
  /** 0 (default) asks the OS for an ephemeral port. */
  port?: number;
  /** Owner pid; defaults to `process.pid` (test seam). */
  pid?: number;
  /** OS hostname recorded in the lease; defaults to `os.hostname()`. */
  hostname?: string;
  holderId?: string;
  now?: () => string;
  /** Store factory seam; the daemon owns and closes the returned handle. */
  openStore?: (repoRoot: string) => DaemonStoreHandle;
  isAlive?: (pid: number) => boolean;
  readStartIdentity?: (pid: number) => string | null;
}

/**
 * Start a cliyardd instance that serves the read-only Control API on a
 * loopback-bound port. The returned daemon owns the listener, the lease and
 * the store; `stop()` releases all three.
 */
export async function startControlApiDaemon(
  options: StartControlApiDaemonOptions,
): Promise<CliyardDaemon> {
  const repoRoot = resolve(options.repoRoot);
  assertRepoRoot(repoRoot);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new DaemonError(
      `port must be an integer from 0 to 65535 (got ${String(port)})`,
    );
  }
  const pid = options.pid ?? process.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new DaemonError("pid must be a positive integer");
  }
  const host = options.hostname ?? osHostname();
  const now = options.now ?? (() => new Date().toISOString());
  const holderId = options.holderId ?? randomUUID();
  const readIdentity =
    options.readStartIdentity ?? readProcessStartIdentity;

  const handle = (options.openStore ?? openDaemonStore)(repoRoot);
  const sockets = new Set<Socket>();
  const server = createHttpServer(repoRoot, sockets);

  let lease: DaemonLeaseRecord | null = null;
  try {
    await listen(server, DAEMON_CONTROL_HOST, port);
    const address = boundAddress(server);
    const startedAt = now();
    lease = await handle.leases.acquire(
      {
        holderId,
        pid,
        host,
        repoRoot,
        startedAt,
        processStartIdentity: readIdentity(pid),
        address,
      },
      {
        isAlive: options.isAlive,
        readStartIdentity: options.readStartIdentity,
      },
    );

    const info: DaemonInfo = {
      pid,
      address: { ...address },
      addressText: `${address.host}:${address.port}`,
      repoRoot,
      storePath: handle.storePath,
      backend: handle.backend,
      holderId,
      startedAt,
    };
    const daemon = new CliyardDaemon({
      info,
      handle,
      server,
      sockets,
      lease,
    });
    server.on("error", (error) => {
      if (daemon.state !== "running") return;
      void daemon.stop(`server-error: ${errorMessage(error)}`);
    });
    return daemon;
  } catch (error) {
    await closeServer(server, sockets).catch(() => {});
    if (lease !== null) {
      await handle.leases.release(lease).catch(() => {});
    }
    try {
      handle.close();
    } catch {
      /* the original error is the useful one */
    }
    throw error;
  }
}

function createHttpServer(
  repoRoot: string,
  sockets: Set<Socket>,
): HttpServer {
  const server = createServer(createControlApiHandler({ repoRoot }));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  return server;
}

function assertRepoRoot(repoRoot: string): void {
  let stat;
  try {
    stat = statSync(repoRoot);
  } catch (error) {
    throw new DaemonError(
      `repository root is not readable: ${repoRoot} (${errorMessage(error)})`,
    );
  }
  if (!stat.isDirectory()) {
    throw new DaemonError(`repository root is not a directory: ${repoRoot}`);
  }
}

function listen(
  server: HttpServer,
  host: string,
  port: number,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

function boundAddress(server: NetServer): DaemonAddress {
  const address = server.address();
  if (
    address === null ||
    typeof address === "string" ||
    address.address !== DAEMON_CONTROL_HOST ||
    !Number.isInteger(address.port) ||
    address.port < 1 ||
    address.port > 65535
  ) {
    throw new DaemonError(
      `unexpected bound address: ${JSON.stringify(address)}`,
    );
  }
  return { host: DAEMON_CONTROL_HOST, port: address.port };
}

function closeServer(
  server: HttpServer,
  sockets: ReadonlySet<Socket>,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    try {
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolvePromise();
      });
    } catch (error) {
      reject(error);
      return;
    }
    // A keep-alive client must not be able to hold the lease hostage during
    // shutdown. Responses already buffered on the socket are best-effort.
    for (const socket of sockets) socket.destroy();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
