/**
 * Durable activated ProfileCatalog under `.cliyard/profile-catalog.json`
 * (design/profile-catalog-admission-v0.md).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  parseExecutionProfile,
  type ExecutionProfile,
} from "../execution/profile.js";
import {
  isProfileBindingCapacity,
  PROFILE_CATALOG_VERSION,
  type BindingLimitSource,
  type ProfileBindingCapacity,
  type ProfileCatalogRecord,
} from "./types.js";

export class ProfileCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export function profileCatalogPath(repoRoot: string): string {
  return join(repoRoot, ".cliyard", "profile-catalog.json");
}

function emptyCatalog(now: string): ProfileCatalogRecord {
  return {
    version: PROFILE_CATALOG_VERSION,
    updatedAt: now,
    profiles: [],
    capacities: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCatalog(value: unknown): ProfileCatalogRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== PROFILE_CATALOG_VERSION) return undefined;
  if (typeof value.updatedAt !== "string" || value.updatedAt.trim() === "") {
    return undefined;
  }
  if (!Array.isArray(value.profiles) || !Array.isArray(value.capacities)) {
    return undefined;
  }

  const profiles: ExecutionProfile[] = [];
  for (const entry of value.profiles) {
    const parsed = parseExecutionProfile(entry);
    if (!parsed) return undefined;
    profiles.push(parsed);
  }

  const capacities: ProfileBindingCapacity[] = [];
  for (const entry of value.capacities) {
    if (!isProfileBindingCapacity(entry)) return undefined;
    capacities.push({
      profileId: entry.profileId,
      configuredMax: entry.configuredMax,
      limitSource: entry.limitSource,
      inFlight: entry.inFlight,
    });
  }

  const profileIds = new Set(profiles.map((p) => p.profileId));
  for (const cap of capacities) {
    if (!profileIds.has(cap.profileId)) return undefined;
  }

  return {
    version: PROFILE_CATALOG_VERSION,
    updatedAt: value.updatedAt,
    profiles,
    capacities,
  };
}

function writeCatalog(repoRoot: string, catalog: ProfileCatalogRecord): void {
  const path = profileCatalogPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function loadProfileCatalog(repoRoot: string): ProfileCatalogRecord {
  const path = profileCatalogPath(repoRoot);
  if (!existsSync(path)) {
    return emptyCatalog(new Date(0).toISOString());
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new ProfileCatalogError(`invalid JSON at ${path}`);
  }
  const parsed = parseCatalog(raw);
  if (!parsed) {
    throw new ProfileCatalogError(`invalid ProfileCatalog at ${path}`);
  }
  return parsed;
}

export function saveProfileCatalog(
  repoRoot: string,
  catalog: ProfileCatalogRecord,
  now: () => string = () => new Date().toISOString(),
): ProfileCatalogRecord {
  const parsed = parseCatalog(catalog);
  if (!parsed) {
    throw new ProfileCatalogError("refusing to persist invalid ProfileCatalog");
  }
  const next: ProfileCatalogRecord = {
    ...parsed,
    updatedAt: now(),
  };
  writeCatalog(repoRoot, next);
  return next;
}

export interface ActivateProfileInput {
  repoRoot: string;
  profile: unknown;
  /** Defaults to unknown / null configuredMax (probe permit). */
  configuredMax?: number | null;
  limitSource?: BindingLimitSource;
  now?: () => string;
}

/**
 * Activate (add or replace) a secret-free ExecutionProfile in the catalog.
 * Uses parseExecutionProfile — credential-like / URL fields are refused.
 */
export function activateProfile(
  input: ActivateProfileInput,
): ProfileCatalogRecord {
  const parsed = parseExecutionProfile(input.profile);
  if (!parsed) {
    throw new ProfileCatalogError(
      "refusing to activate invalid or secret-bearing ExecutionProfile",
    );
  }

  const configuredMax =
    input.configuredMax === undefined ? null : input.configuredMax;
  if (
    configuredMax !== null &&
    (typeof configuredMax !== "number" ||
      !Number.isInteger(configuredMax) ||
      configuredMax < 1)
  ) {
    throw new ProfileCatalogError("configuredMax must be null or an integer >= 1");
  }

  const limitSource: BindingLimitSource =
    input.limitSource ??
    (configuredMax === null ? "unknown" : "operator");
  if (
    limitSource !== "operator" &&
    limitSource !== "provider-reported" &&
    limitSource !== "observed" &&
    limitSource !== "unknown"
  ) {
    throw new ProfileCatalogError(`invalid limitSource: ${String(limitSource)}`);
  }

  const now = input.now ?? (() => new Date().toISOString());
  const current = loadProfileCatalog(input.repoRoot);
  const profiles = current.profiles.filter(
    (p) => p.profileId !== parsed.profileId,
  );
  profiles.push(parsed);
  profiles.sort((a, b) => a.profileId.localeCompare(b.profileId));

  const prior = current.capacities.find(
    (c) => c.profileId === parsed.profileId,
  );
  const capacities = current.capacities.filter(
    (c) => c.profileId !== parsed.profileId,
  );
  capacities.push({
    profileId: parsed.profileId,
    configuredMax,
    limitSource,
    inFlight: prior?.inFlight ?? 0,
  });
  capacities.sort((a, b) => a.profileId.localeCompare(b.profileId));

  return saveProfileCatalog(
    input.repoRoot,
    {
      version: PROFILE_CATALOG_VERSION,
      updatedAt: current.updatedAt,
      profiles,
      capacities,
    },
    now,
  );
}

export function getProfile(
  repoRoot: string,
  profileId: string,
): ExecutionProfile | null {
  const catalog = loadProfileCatalog(repoRoot);
  return catalog.profiles.find((p) => p.profileId === profileId) ?? null;
}

export function listProfiles(repoRoot: string): ExecutionProfile[] {
  return loadProfileCatalog(repoRoot).profiles.slice();
}

export function removeProfile(
  repoRoot: string,
  profileId: string,
  now: () => string = () => new Date().toISOString(),
): ProfileCatalogRecord {
  const current = loadProfileCatalog(repoRoot);
  const profiles = current.profiles.filter((p) => p.profileId !== profileId);
  if (profiles.length === current.profiles.length) {
    throw new ProfileCatalogError(`profile not found: ${profileId}`);
  }
  const capacities = current.capacities.filter(
    (c) => c.profileId !== profileId,
  );
  return saveProfileCatalog(
    repoRoot,
    {
      version: PROFILE_CATALOG_VERSION,
      updatedAt: current.updatedAt,
      profiles,
      capacities,
    },
    now,
  );
}

export interface SetBindingCapacityInput {
  repoRoot: string;
  profileId: string;
  configuredMax: number | null;
  limitSource?: BindingLimitSource;
  inFlight?: number;
  now?: () => string;
}

export function setBindingCapacity(
  input: SetBindingCapacityInput,
): ProfileBindingCapacity {
  const catalog = loadProfileCatalog(input.repoRoot);
  if (!catalog.profiles.some((p) => p.profileId === input.profileId)) {
    throw new ProfileCatalogError(`profile not found: ${input.profileId}`);
  }
  if (
    input.configuredMax !== null &&
    (typeof input.configuredMax !== "number" ||
      !Number.isInteger(input.configuredMax) ||
      input.configuredMax < 1)
  ) {
    throw new ProfileCatalogError("configuredMax must be null or an integer >= 1");
  }
  const prior = catalog.capacities.find(
    (c) => c.profileId === input.profileId,
  );
  const inFlight =
    input.inFlight === undefined ? (prior?.inFlight ?? 0) : input.inFlight;
  if (
    typeof inFlight !== "number" ||
    !Number.isInteger(inFlight) ||
    inFlight < 0
  ) {
    throw new ProfileCatalogError("inFlight must be an integer >= 0");
  }
  const limitSource: BindingLimitSource =
    input.limitSource ??
    (input.configuredMax === null ? "unknown" : "operator");

  const capacity: ProfileBindingCapacity = {
    profileId: input.profileId,
    configuredMax: input.configuredMax,
    limitSource,
    inFlight,
  };
  if (!isProfileBindingCapacity(capacity)) {
    throw new ProfileCatalogError("invalid binding capacity");
  }

  const capacities = catalog.capacities.filter(
    (c) => c.profileId !== input.profileId,
  );
  capacities.push(capacity);
  capacities.sort((a, b) => a.profileId.localeCompare(b.profileId));

  saveProfileCatalog(
    input.repoRoot,
    {
      version: PROFILE_CATALOG_VERSION,
      updatedAt: catalog.updatedAt,
      profiles: catalog.profiles,
      capacities,
    },
    input.now ?? (() => new Date().toISOString()),
  );
  return capacity;
}

export function getBindingCapacity(
  repoRoot: string,
  profileId: string,
): ProfileBindingCapacity | null {
  const catalog = loadProfileCatalog(repoRoot);
  return catalog.capacities.find((c) => c.profileId === profileId) ?? null;
}
