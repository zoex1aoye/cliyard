/** Task lifecycle for Route C control plane (mock + real later). */
export type TaskStatus =
  | "draft"
  | "ready"
  | "running"
  | "verifying"
  | "repairing"
  | "accepted"
  | "blocked"
  | "rejected"
  | "cancelled";

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["ready", "cancelled"],
  ready: ["running", "cancelled"],
  running: ["verifying", "blocked", "cancelled"],
  verifying: ["accepted", "repairing", "rejected", "blocked"],
  repairing: ["running", "rejected", "blocked", "cancelled"],
  accepted: [],
  blocked: ["ready", "cancelled"],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal status transition: ${from} → ${to}`);
  }
}

export function isTerminal(status: TaskStatus): boolean {
  return status === "accepted" || status === "rejected" || status === "cancelled";
}
