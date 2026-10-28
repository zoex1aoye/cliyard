# Execution Authority v1

> Recorded: 2026-10-28
>
> Status: design decision recorded; implementation starts with queue adoption
> and execution-authority hardening

## 1. Decision

The next product bottleneck is not another model prompt or a richer batch
runner. It is the missing authority chain between an approved task, a selected
execution profile, an admitted resource slot, a live worker process and a
human-reviewed exception.

The durable chain is:

```text
Intent
  -> approved Plan / frozen TaskContract
  -> RouteDecision
  -> AdmissionDecision / Lease
  -> WorkerLease
  -> independent VerificationEvidence
  -> verdict

             blocked or interrupted
                       |
                       v
             OperatorResolution
```

Queue, Supervisor, adapters and RuntimeManager may implement parts of this
chain, but none of them may invent a second source of truth.

## 2. Current boundary

The repository has a credible foreground control-plane kernel:

- approved Plans compile into deterministic frozen contracts;
- queue items bind frozen contracts or approved Plans;
- first dispatch persists an explicit run id before worker execution;
- worker exits and reused worktrees receive path audits;
- health-gated deadline extension and budget continuation are bounded and
  persisted;
- POSIX workers receive exact process-group identity and descendant cleanup;
- runtime ports, readiness, manifests and exact orphan recovery exist;
- failure and cost evidence are structured and non-authoritative where
  appropriate.

It does not yet have:

- a real profile catalog, endpoint/account activation or dynamic routing;
- a shared admission broker across queue items and Plan ready waves;
- a durable WorkerLease written at spawn time;
- a recovery policy for a detached worker group when cliyard is `SIGKILL`ed;
- Windows Job Object process-tree ownership;
- a formal operator path for accepting reviewed work from a blocked run.

Current measurement at the recording baseline:

```text
npm run build: pass
npm test:      361/362
```

The failing deadline-extension fixture is reproducible in isolation and uses a
2.2-second combined deadline/fixture window. It must be stabilized before new
parallel authority is added. The failure is not evidence that the production
deadline semantics are wrong; it is a red quality gate.

## 3. Route, admission and ownership are separate records

### 3.1 RouteDecision

Routing answers which predeclared execution profile is eligible:

```ts
interface RouteDecision {
  version: 1;
  taskId: string;
  profileId: string;
  runtimeId: string;
  modelId: string;
  providerId: string;
  endpointRef?: string;
  accountBindingId?: string;
  capabilityChecks: string[];
  rejectedProfileReasons: Array<{
    profileId: string;
    reason: string;
  }>;
  selectedAt: string;
}
```

Before scoring exists, the router performs deterministic hard filtering and
uses an operator preference order. An LLM may recommend a profile, but cannot
own the persisted decision.

Profile selection is not proof that an endpoint or account was activated. The
adapter must return or persist a binding activation result before dispatch.

### 3.2 AdmissionDecision / Lease

Admission answers whether the selected profile may run now:

```text
queue-item slot
  + task slot
  + execution-profile slot
  + runtime/device slot
  + port/browser/database lease
  + budget and host capacity
```

Limits are conjunctive. Multiple local maxima must never multiply into an
unbounded worker burst. Unknown profile capacity begins with one in-flight
probe, not a public nominal concurrency value.

### 3.3 WorkerLease

Ownership answers which controller owns which process tree:

```ts
interface WorkerLease {
  version: 1;
  leaseId: string;
  queueItemId?: string;
  runId: string;
  taskId: string;
  attempt: number;
  executionProfileId: string;
  controller: {
    pid: number;
    host: string;
    processIdentity: string;
  };
  worker: {
    pid: number;
    pgid?: number;
    osStartIdentity?: string;
    captureMode: "posix-group" | "windows-job" | "exact-child";
  };
  workspace: string;
  createdAt: string;
  heartbeatAt: string;
  cleanup: "pending" | "terminated" | "unknown";
}
```

The lease must be persisted as soon as the worker identity is available, not
only after `collect()` returns.

## 4. Controller death policy

`SIGKILL` cannot run in-process cleanup. The first implementation should
therefore guarantee recoverability, not pretend that a Node signal handler is
sufficient.

Recommended v1 policy:

```text
controller dies
  -> a new controller reads WorkerLease
  -> verify exact worker identity
  -> if the owned group is alive:
       terminate that exact group
       preserve the worktree and prior evidence
       resume through an explicit new attempt or provider-session continuation
  -> if the group is gone:
       inspect result artifacts and verify what can be proven
  -> ambiguous identity or cleanup:
       needs_human; never guess from pid, pgid or process name alone
```

Reattaching to an orphaned CLI's old stdout pipe is not a v1 promise. If the
worker must outlive the controller in future, that requires an external
guardian or OS service manager and a separate evidence protocol.

## 5. ProcessOwnerProvider

Windows and POSIX differences belong behind one platform boundary:

```ts
interface ProcessOwnerProvider {
  captureAtSpawn(child: ChildProcess): Promise<WorkerProcessIdentity>;
  inspectLease(lease: WorkerLease): Promise<LeaseState>;
  terminateTree(lease: WorkerLease, reason: string): Promise<CleanupResult>;
  cleanupWhenOwnerDies?(lease: WorkerLease): Promise<void>;
}
```

- macOS/Linux: dedicated POSIX process group plus exact OS identity.
- Windows: Job Object ownership; exact-child cleanup remains an explicit
  degraded mode until the Job Object provider exists.
- Unknown identity or unsupported cleanup is fail-closed for unattended work.

Windows support must not be represented as equivalent to POSIX until a real
Job Object implementation and tests exist.

## 6. OperatorResolution for blocked work

A blocked RunManifest must never be rewritten to hide the original failure.
Human acceptance of reviewed work is a separate immutable queue resolution:

```ts
interface OperatorResolution {
  version: 1;
  kind: "manual-adoption";
  queueItemId: string;
  sourceRunId: string;
  sourceManifestStatus: "blocked" | "interrupted";
  baseCommit: string;
  contractsHash: string;
  reviewedCommit: string;
  reviewEvidencePath: string;
  reviewEvidenceHash: string;
  approvedBy: string;
  approvedAt: string;
  reason: string;
}
```

Adoption requirements:

1. only a blocked/interrupted item with a matching run id may be adopted;
2. the reviewed commit is a full immutable Git object id;
3. the frozen contracts identity still matches;
4. review evidence records successful checks on the reviewed commit;
5. the original RunManifest remains blocked/interrupted;
6. the queue records the resolution and its own terminal state separately;
7. downstream Plan materialization uses the reviewed commit only through an
   explicit adopted lineage path, not by pretending the source run completed;
8. repeated adoption is idempotent only for byte-identical review evidence and
   otherwise fails closed;
9. no adoption may rewrite acceptance evidence, push or merge to main.

## 7. Implementation order

```text
1. Stabilize the deadline-extension timing fixture.
2. Implement queue adoption with OperatorResolution and read-only status.
3. Persist WorkerLease at spawn; define owner-death recovery semantics.
4. Add a secret-free ProfileCatalog and prove real profile activation.
5. Replace repo-global long-running Supervisor ownership with per-run
   ownership plus short control-store locks.
6. Add fixed hierarchical admission for two queue items and Plan ready waves.
7. Add the Windows Job Object ProcessOwnerProvider.
8. Add deterministic routing scores only after measured telemetry exists.
```

Steps 1 and 2 are the current dispatchable slice. Step 3 is the safety
prerequisite for parallel execution.

## 8. Non-goals for the current slice

- no dynamic scoring or adaptive concurrency;
- no silent endpoint/account fallback;
- no parallel queue dispatch yet;
- no Windows process-tree equivalence claim;
- no daemon, cross-host recovery or 24-hour unattended claim;
- no automatic rewrite of a blocked RunManifest;
- no automatic push or main merge;
- no storing secrets, raw prompts or provider credentials in queue records.
