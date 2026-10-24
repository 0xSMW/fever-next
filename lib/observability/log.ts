import "server-only";

const secretKey = /password|secret|token|credential|authorization|cookie|digest|api.?key|raw.?html|ciphertext|email|url|query|body/i;
function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth limit]";
  if (Array.isArray(value)) return value.slice(0, 100).map(v => redact(v, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, secretKey.test(key) ? "[redacted]" : redact(item, depth + 1)]));
  if (typeof value === "string") return value.slice(0, 500).replace(/(?:https?:\/\/|[A-Z0-9._%+-]+@)\S+/gi, "[redacted]");
  return typeof value === "bigint" ? value.toString() : value;
}
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.info(JSON.stringify({ time: new Date().toISOString(), event, ...redact(fields) as object }));
}
