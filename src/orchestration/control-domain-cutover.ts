/**
 * Production cutover for ledger + queue event-journal onto the shared control
 * StateStore (design/ledger-journal-production-cutover-v0.md,
 * design/statestore-path-unify-v0.md).
 *
 * Run, queue, ledger and audit-event domains share `.cliyard/state.db`. This
 * module keeps one process-scoped handle open so `saveLedger` /
 * `appendQueueEvent` bindings remain valid across calls.
 *
 * Intentionally does not import `queue-store.ts` (avoids a load cycle with
 * mutateQueueDocument). Paths come from `statestore/paths`.
 */
import { dirname, resolve } from "node:path";
import {
  createLegacyJsonGuard,
  findCoveringMarker,
  migrateLegacyJson,
} from "../statestore/migrate.js";
import {
  resolveControlStatePaths,
} from "../statestore/paths.js";
import {
  FileEvidenceStore,
  openFileStateStore,
  type StateStore,
} from "../statestore/store.js";
import type { StateStoreDomainEvidenceStore } from "../statestore/write.js";
import {
  attachLedgerStateStore,
  defaultLedgerPath,
  detachLedgerStateStore,
  isLedgerStateStoreAttached,
} from "../persistence/ledger.js";
import {
  attachQueueEventStateStoreWithMigrate,
  detachQueueEventStateStore,
  isQueueEventStateStoreAttached,
} from "./event-journal.js";
import { setLedgerJournalCutoverHook } from "./queue-store.js";

const MIGRATE_API = {
  createLegacyJsonGuard,
  findCoveringMarker,
  migrateLegacyJson,
} as const;

interface ControlDomainHandles {
  repoRoot: string;
  store: StateStore;
  evidence: StateStoreDomainEvidenceStore;
}

const controlHandles = new Map<string, ControlDomainHandles>();

function getOrOpenControlHandles(repoRoot: string): ControlDomainHandles {
  const root = resolve(repoRoot);
  const existing = controlHandles.get(root);
  if (existing !== undefined) return existing;
  const { paths } = resolveControlStatePaths(root);
  const evidence = new FileEvidenceStore({
    directory: paths.evidenceDir,
  });
  const store = openFileStateStore({
    path: paths.dbPath,
  });
  const handles: ControlDomainHandles = {
    repoRoot: root,
    store,
    evidence,
  };
  controlHandles.set(root, handles);
  return handles;
}

/**
 * Idempotently attach ledger + event-journal cutovers for `repoRoot`.
 * Safe to call from sync production paths (queue mutations, updateLedger).
 */
export function ensureLedgerJournalCutoverSync(repoRoot: string): void {
  const root = resolve(repoRoot);
  const ledgerPath = defaultLedgerPath(root);
  const needLedger = !isLedgerStateStoreAttached(ledgerPath);
  const needJournal = !isQueueEventStateStoreAttached(root);
  if (!needLedger && !needJournal) return;

  const handles = getOrOpenControlHandles(root);
  if (needLedger) {
    attachLedgerStateStore({
      repoRoot: root,
      store: handles.store,
      evidence: handles.evidence,
    });
  }
  if (needJournal) {
    attachQueueEventStateStoreWithMigrate(
      {
        repoRoot: root,
        store: handles.store,
        evidence: handles.evidence,
      },
      MIGRATE_API,
    );
  }
}

/**
 * Derive the repository root from a ledger path
 * (`<repo>/.cliyard/ledger.json`).
 */
export function repoRootFromLedgerPath(ledgerPath: string): string {
  const resolved = resolve(ledgerPath);
  const parent = dirname(resolved); // .../.cliyard
  const name = resolved.split(/[/\\]/).pop();
  if (name !== "ledger.json") {
    throw new Error(
      `cannot derive repoRoot from ledger path ${ledgerPath} ` +
        "(expected filename ledger.json)",
    );
  }
  const cliyardName = parent.split(/[/\\]/).pop();
  if (cliyardName !== ".cliyard") {
    throw new Error(
      `cannot derive repoRoot from ledger path ${ledgerPath} ` +
        "(expected <repo>/.cliyard/ledger.json)",
    );
  }
  return dirname(parent);
}

/**
 * Test/rollback helper: detach domain bindings and close the process-scoped
 * control store for one repo.
 */
export function resetControlDomainCutover(repoRoot: string): void {
  const root = resolve(repoRoot);
  detachLedgerStateStore(defaultLedgerPath(root));
  detachQueueEventStateStore(root);
  const handles = controlHandles.get(root);
  if (handles !== undefined) {
    handles.store.close();
    controlHandles.delete(root);
  }
}

// Register after exports so queue-store can finish evaluating first when this
// module is loaded through migrate/queue entrypoints.
setLedgerJournalCutoverHook(ensureLedgerJournalCutoverSync);
