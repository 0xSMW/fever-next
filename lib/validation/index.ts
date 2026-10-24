/** Validation shared by server services. Never coerce arbitrary posted values. */
export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code = "INVALID_INPUT",
    public readonly status = 400,
    public readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export function object(value: unknown, field = "payload"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new DomainError(`Unknown field: ${unknown}.`, "INVALID_INPUT", 400, { [unknown]: "This field is not supported." });
}

export function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new DomainError(`${field} must be an integer between ${min} and ${max}.`, "INVALID_INPUT", 400, { [field]: "Invalid integer." });
  }
  return value;
}

export function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new DomainError(`${field} must be true or false.`, "INVALID_INPUT", 400, { [field]: "Invalid boolean." });
  return value;
}

export function text(value: unknown, field: string, max = 4096, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > max || value.includes("\0") || (!allowEmpty && !value.trim())) {
    throw new DomainError(`${field} must be ${allowEmpty ? "" : "a nonempty "}text of at most ${max} characters.`, "INVALID_INPUT", 400, { [field]: "Invalid text." });
  }
  return value;
}

export function enumeration<T extends string | number>(value: unknown, field: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T)) throw new DomainError(`Invalid ${field}.`, "INVALID_INPUT", 400, { [field]: "Choose a supported value." });
  return value as T;
}

export function ids(value: unknown, field = "ids", max = 10000): number[] {
  if (!Array.isArray(value) || value.length > max) throw new DomainError(`${field} must be a list of at most ${max} IDs.`);
  return [...new Set(value.map((id) => integer(id, field, 1)))];
}

export function confirmed(value: unknown) {
  if (value !== true) throw new DomainError("Confirm this deletion after reviewing its affected subscriptions and saved items.", "CONFIRMATION_REQUIRED", 409);
}

/** Subscription syntax only; DNS, private-origin policy, and redirects are checked by the safe transport. */
export function feedUrl(value: unknown): string {
  const raw = text(value, "url", 8192, false).trim().replace(/^feed:\/\//i, "http://");
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new DomainError("Feed URLs cannot contain control characters.");
  let url: URL;
  try { url = new URL(raw); } catch { throw new DomainError("Enter a complete HTTP or HTTPS feed URL.", "INVALID_INPUT", 400, { url: "Invalid URL." }); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new DomainError("Feed URLs must use HTTP or HTTPS and must not contain credentials.", "INVALID_INPUT", 400, { url: "Use the separate username and password fields." });
  }
  if (!url.hostname) throw new DomainError("The feed URL must contain a host.");
  // Retain the validated spelling for source-compatible subscription identity.
  // URL parsing for network requests is performed separately by the safe transport.
  return raw;
}

export function errorResponse(error: unknown): { status: number; body: { error: string; code: string; fields?: Record<string, string> } } {
  if (error instanceof DomainError) return { status: error.status, body: { error: error.message, code: error.code, fields: error.fields } };
  return { status: 500, body: { error: "The request could not be completed.", code: "INTERNAL_ERROR" } };
}
