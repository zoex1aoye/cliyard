/**
 * MVP M3: human freeze — set frozen/frozenAt, validate, persist + sha256.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  assertLocalCliTaskContract,
  type LocalCliTaskContract,
} from "./taskcontract.js";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function contractHashSidecarPath(contractPath: string): string {
  return `${contractPath}.sha256`;
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function freezeContract(
  draft: unknown,
  opts?: { frozenAt?: string },
): LocalCliTaskContract {
  if (draft === null || typeof draft !== "object" || Array.isArray(draft)) {
    throw new Error("freeze requires a contract object");
  }
  const copy = { ...(draft as Record<string, unknown>) };
  if (copy.frozen === true && typeof copy.frozenAt === "string") {
    // Re-validate existing frozen contract (idempotent freeze).
    return assertLocalCliTaskContract(copy);
  }
  copy.frozen = true;
  copy.frozenAt =
    opts?.frozenAt?.trim() ||
    new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return assertLocalCliTaskContract(copy);
}

export function writeFrozenContract(input: {
  contract: LocalCliTaskContract;
  outPath: string;
}): { path: string; hashPath: string; sha256: string; bytes: string } {
  if (!input.contract.frozen) {
    throw new Error("writeFrozenContract requires frozen=true");
  }
  const path = resolve(input.outPath);
  mkdirSync(dirname(path), { recursive: true });
  const bytes = stableStringify(input.contract);
  const sha256 = sha256Hex(bytes);
  writeFileSync(path, bytes, "utf8");
  const hashPath = contractHashSidecarPath(path);
  writeFileSync(hashPath, `${sha256}\n`, "utf8");
  return { path, hashPath, sha256, bytes };
}

/**
 * Fail closed if a sha256 sidecar exists and does not match current bytes.
 * Missing sidecar is allowed for legacy fixtures (M0/M1 mocks).
 */
export function assertFrozenImmutable(contractPath: string): {
  path: string;
  sha256: string | null;
  checked: boolean;
} {
  const path = resolve(contractPath);
  const hashPath = contractHashSidecarPath(path);
  if (!existsSync(path)) {
    throw new Error(`contract not found: ${path}`);
  }
  const bytes = readFileSync(path, "utf8");
  const contract = assertLocalCliTaskContract(JSON.parse(bytes));
  if (!contract.frozen) {
    throw new Error(
      `contract ${contract.contractId} is not frozen; refuse dispatch`,
    );
  }
  if (!existsSync(hashPath)) {
    return { path, sha256: null, checked: false };
  }
  const expected = readFileSync(hashPath, "utf8").trim();
  const actual = sha256Hex(bytes.endsWith("\n") ? bytes : `${bytes}\n`);
  // Accept either exact file bytes hash or normalized stable stringify hash.
  const actualRaw = sha256Hex(bytes);
  if (expected !== actual && expected !== actualRaw) {
    throw new Error(
      `frozen contract bytes changed without re-freeze: ${path} ` +
        `(expected sha256 ${expected}, got ${actualRaw}). ` +
        `Create a new contractId/version and freeze again.`,
    );
  }
  return { path, sha256: expected, checked: true };
}

export function loadAndAssertFrozen(contractPath: string): LocalCliTaskContract {
  assertFrozenImmutable(contractPath);
  const raw = JSON.parse(readFileSync(resolve(contractPath), "utf8"));
  return assertLocalCliTaskContract(raw);
}
