/**
 * ProfileCatalog + hierarchical admission public surface.
 */
export {
  admitHierarchical,
  effectiveProfilePermit,
} from "./admit.js";
export {
  ProfileCatalogError,
  activateProfile,
  getBindingCapacity,
  getProfile,
  listProfiles,
  loadProfileCatalog,
  profileCatalogPath,
  removeProfile,
  saveProfileCatalog,
  setBindingCapacity,
} from "./catalog.js";
export {
  admissionDecisionsPath,
  appendAdmissionDecision,
  evaluateQueueAdmission,
  isQueueAdmissionEnabled,
  readAdmissionDecisions,
  type AdmissionDecisionRecord,
  type EvaluateQueueAdmissionInput,
  type QueueAdmissionEvaluation,
  type QueueAdmissionItemView,
  type QueueAdmissionOptions,
} from "./gate.js";
export {
  ExecutionRoutingError,
  appendRoutingDecision,
  readRoutingDecisions,
  routingDecisionsPath,
  selectExecutionProfile,
  type ExecutionRoutingDecision,
  type RoutingAttributionRole,
  type RoutingCandidateView,
  type RoutingDecisionCode,
  type RoutingDecisionRecord,
  type SelectExecutionProfileInput,
  type TaskRoutingRequirements,
} from "./routing.js";
export {
  selectDesignElaboratorProfile,
  type DesignElaboratorMode,
  type DesignRoutingDecision,
  type DesignRoutingRequirements,
  type SelectDesignElaboratorProfileInput,
} from "./design-routing.js";
export {
  evaluateQueueRoutingGate,
  isQueueRoutingEnabled,
  resolveRoutedExecutionProfile,
  type QueueRoutingOptions,
  type ResolveRoutedExecutionProfileInput,
} from "./queue-routing-wire.js";
export {
  PROFILE_CATALOG_VERSION,
  UNKNOWN_EXECUTION_PROFILE_PERMIT,
  isProfileBindingCapacity,
  type AdmissionScopeLimit,
  type AdmissionScopeName,
  type BindingLimitSource,
  type HierarchicalAdmissionDecision,
  type HierarchicalAdmissionRequest,
  type ProfileBindingCapacity,
  type ProfileCatalogRecord,
} from "./types.js";
