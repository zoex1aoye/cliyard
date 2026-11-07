/**
 * Verification surface: synchronous shell verifier + background VerificationTask v0.
 */
export {
  createMockVerifier,
  createShellVerifier,
  wantsRealVerify,
  type ShellVerifierOptions,
  type Verifier,
  type VerifyResult,
  type VerifyRuntimeEvidence,
} from "./verifier.js";

export {
  VERIFICATION_TASK_SPEC_VERSION,
  VERIFICATION_TASK_STATUSES,
  isTerminalVerificationStatus,
  isVerificationTask,
  isVerificationTaskStatus,
  type VerificationTask,
  type VerificationTaskOutput,
  type VerificationTaskStatus,
} from "./task-types.js";

export {
  VERIFICATION_DIR_NAME,
  ensureVerificationDir,
  listVerificationTasks,
  loadVerificationTask,
  saveVerificationTask,
  verificationDir,
  verificationTaskPath,
} from "./task-store.js";

export {
  awaitVerificationTask,
  markVerificationDelivered,
  putVerificationTaskForTest,
  startVerificationTask,
  type StartVerificationTaskInput,
  type StartVerificationTaskResult,
} from "./task-runner.js";

export {
  recoverVerificationTasks,
  type RecoverVerificationTasksOptions,
  type RecoverVerificationTasksResult,
} from "./task-recovery.js";
