/**
 * Bound and secret-scan intervention text fields
 * (design/intervention-ledger-v0.md).
 */
export const MAX_INTERVENTION_REASON_CHARS = 2_000;
export const MAX_INTERVENTION_NOTE_CHARS = 2_000;
export const MAX_INTERVENTION_ARTIFACT_REF_CHARS = 512;

export class InterventionSanitizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Obvious credential-shaped substrings — refuse, do not store. */
const SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._\-+=\/]{16,}\b/i },
  { name: "api-key-assignment", re: /\b(?:api[_-]?key|x-api-key|secret[_-]?key)\b\s*[:=]\s*\S+/i },
  { name: "sk-prefix", re: /\bsk-[A-Za-z0-9]{16,}\b/ },
  { name: "openai-project-key", re: /\bsk-proj-[A-Za-z0-9_\-]{16,}\b/ },
  { name: "github-pat", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
];

export function assertNoSecretLike(
  text: string,
  field: string,
): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(text)) {
      throw new InterventionSanitizeError(
        `${field} looks like a secret (${pattern.name}) and is refused`,
      );
    }
  }
}

export function sanitizeInterventionText(
  value: string,
  field: string,
  maxChars: number,
): string {
  if (typeof value !== "string") {
    throw new InterventionSanitizeError(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new InterventionSanitizeError(`${field} must be non-empty`);
  }
  if (trimmed.length > maxChars) {
    throw new InterventionSanitizeError(
      `${field} exceeds ${maxChars} characters`,
    );
  }
  assertNoSecretLike(trimmed, field);
  return trimmed;
}
