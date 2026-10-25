import type { Capabilities, HarnessConfig, WorkerId } from "./types.js";
import { shellQuote, wslExec } from "./wsl.js";

const WORKER_BINS: Record<WorkerId, string[]> = {
  claude: ["claude"],
  codex: ["codex"],
  codebuddy: ["codebuddy", "codebuddy-code"],
};

export async function discover(cfg: HarnessConfig): Promise<Capabilities> {
  const notes: string[] = [];
  const caps: Capabilities = {
    distro: cfg.distro,
    wslOk: false,
    workers: {},
    gitOk: false,
    notes,
  };

  try {
    const ping = await wslExec("echo ok && uname -s", {
      distro: cfg.distro,
      timeoutMs: 15_000,
    });
    caps.wslOk = ping.code === 0 && ping.stdout.includes("ok");
    if (!caps.wslOk) {
      notes.push(`wsl ping failed: ${ping.stderr || ping.stdout}`);
      return caps;
    }
  } catch (e) {
    notes.push(`wsl.exe not usable from this host: ${String(e)}`);
    notes.push(
      "Run doctor on Windows with WSL installed. Developing on macOS alone cannot exercise the WSL bridge.",
    );
    return caps;
  }

  const git = await wslExec("command -v git && git --version", {
    distro: cfg.distro,
    timeoutMs: 10_000,
  });
  caps.gitOk = git.code === 0;
  if (!caps.gitOk) notes.push("git missing inside WSL");

  for (const id of Object.keys(WORKER_BINS) as WorkerId[]) {
    const bins = WORKER_BINS[id];
    let found: string | undefined;
    for (const bin of bins) {
      const r = await wslExec(`command -v ${shellQuote(bin)}`, {
        distro: cfg.distro,
        timeoutMs: 10_000,
      });
      if (r.code === 0) {
        found = r.stdout.trim().split(/\r?\n/)[0];
        break;
      }
    }
    caps.workers[id] = { path: found ?? "", ok: Boolean(found) };
  }

  const available = (Object.keys(caps.workers) as WorkerId[]).filter(
    (k) => caps.workers[k]?.ok,
  );
  if (!available.length) {
    notes.push(
      "No coding CLI found in WSL PATH. Install at least one of: claude, codex, codebuddy",
    );
  }

  return caps;
}

export function pickWorker(
  cfg: HarnessConfig,
  caps: Capabilities,
  requested: WorkerId | "auto",
): WorkerId {
  if (requested !== "auto") {
    if (!caps.workers[requested]?.ok) {
      throw new Error(`Worker ${requested} not found in WSL PATH`);
    }
    return requested;
  }
  for (const id of cfg.workers) {
    if (caps.workers[id]?.ok) return id;
  }
  throw new Error("No preferred worker available; run doctor and install a CLI");
}
