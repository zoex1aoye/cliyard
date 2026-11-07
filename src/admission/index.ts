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
