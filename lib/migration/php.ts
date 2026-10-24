/** A deliberately small PHP serialization grammar. Strings are decoded by BYTE length. */
export type PhpValue = null | boolean | number | Buffer | PhpArray;
export interface PhpArray { kind: "array"; entries: Array<[number | Buffer, PhpValue]>; }
export class DecodeError extends Error {
  constructor(readonly code: string, readonly offset: number) { super(`${code} at byte ${offset}`); }
}
export function strictBase64(input: string, maxBytes = 16 * 1024 * 1024): Buffer {
  if (input.length > Math.ceil(maxBytes / 3) * 4 || input.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) {
    throw new DecodeError("INVALID_BASE64", 0);
  }
  const bytes = Buffer.from(input, "base64");
  if (bytes.length > maxBytes || bytes.toString("base64") !== input) throw new DecodeError("NONCANONICAL_BASE64", 0);
  return bytes;
}
export function utf8(bytes: Buffer): string {
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (value.includes("\0")) throw new DecodeError("NUL_TEXT", 0);
  return value;
}
export function decodePhp(input: Buffer, options: { maxBytes?: number; maxDepth?: number; maxEntries?: number } = {}): PhpValue {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (input.length > maxBytes) throw new DecodeError("PAYLOAD_TOO_LARGE", 0);
  // Old Fever stored raw serialization; later releases base64-wrapped the same grammar.
  const bytes = /^[Nbisda]:|^N;/.test(input.subarray(0, 3).toString("latin1")) ? input : strictBase64(input.toString("latin1"), maxBytes);
  let offset = 0;
  let entries = 0;
  const error = (code: string): never => { throw new DecodeError(code, offset); };
  const literal = (value: string) => {
    const expected = Buffer.from(value, "ascii");
    if (!bytes.subarray(offset, offset + expected.length).equals(expected)) error("INVALID_DELIMITER");
    offset += expected.length;
  };
  const token = (end: string): string => {
    const pos = bytes.indexOf(end, offset, "ascii");
    if (pos < offset || pos - offset > 64) return error("INVALID_NUMBER");
    const result = bytes.subarray(offset, pos).toString("latin1"); offset = pos + 1; return result;
  };
  const natural = (value: string): number => {
    if (!/^(?:0|[1-9]\d*)$/.test(value)) return error("INVALID_LENGTH");
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number > maxBytes) return error("LENGTH_LIMIT");
    return number;
  };
  const value = (depth: number): PhpValue => {
    if (depth > (options.maxDepth ?? 32)) return error("DEPTH_LIMIT");
    if (++entries > (options.maxEntries ?? 100_000)) return error("ENTRY_LIMIT");
    const type = String.fromCharCode(bytes[offset++] ?? 0);
    if (type === "N") { literal(";"); return null; }
    literal(":");
    if (type === "b") { const raw = token(";"); if (raw !== "0" && raw !== "1") return error("INVALID_BOOLEAN"); return raw === "1"; }
    if (type === "i" || type === "d") {
      const raw = token(";");
      if (!(type === "i" ? /^-?(?:0|[1-9]\d*)$/ : /^-?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?$/).test(raw)) return error("INVALID_NUMBER");
      const number = Number(raw);
      if (!Number.isFinite(number) || (type === "i" && !Number.isSafeInteger(number))) return error("NUMBER_RANGE");
      return number;
    }
    if (type === "s") {
      const length = natural(token(":")); literal('"');
      if (offset + length > bytes.length) return error("STRING_TRUNCATED");
      const result = Buffer.from(bytes.subarray(offset, offset + length)); offset += length; literal('";'); return result;
    }
    if (type === "a") {
      const count = natural(token(":")); literal("{");
      const result: PhpArray = { kind: "array", entries: [] };
      const keys = new Set<string>();
      for (let i = 0; i < count; i++) {
        const key = value(depth + 1);
        if (typeof key !== "number" && !Buffer.isBuffer(key)) return error("INVALID_ARRAY_KEY");
        if (typeof key === "number" && !Number.isSafeInteger(key)) return error("INVALID_ARRAY_KEY");
        const identity = typeof key === "number" ? `i:${key}` : `s:${key.toString("base64")}`;
        if (keys.has(identity)) return error("DUPLICATE_ARRAY_KEY");
        keys.add(identity); result.entries.push([key, value(depth + 1)]);
      }
      literal("}"); return result;
    }
    // O/C/R/r and all other executable or reference-bearing forms are unsupported.
    return error("UNSUPPORTED_PHP_TYPE");
  };
  const decoded = value(0);
  if (offset !== bytes.length) error("TRAILING_BYTES");
  return decoded;
}
export function phpObject(value: PhpValue): Record<string, PhpValue> {
  if (!value || typeof value !== "object" || Buffer.isBuffer(value) || value.kind !== "array") throw new DecodeError("EXPECTED_ARRAY", 0);
  const result: Record<string, PhpValue> = Object.create(null);
  for (const [key, entry] of value.entries) {
    if (!Buffer.isBuffer(key)) throw new DecodeError("EXPECTED_STRING_KEY", 0);
    const name = utf8(key);
    if (Object.hasOwn(result, name)) throw new DecodeError("DUPLICATE_KEY", 0);
    result[name] = entry;
  }
  return result;
}
/** Encode only this module's scalar/array representation, never class instances. */
export function encodePhp(value: PhpValue): Buffer {
  const encode = (entry: PhpValue, depth: number): Buffer => {
    if (depth > 32) throw new DecodeError("DEPTH_LIMIT", 0);
    if (entry === null) return Buffer.from("N;");
    if (typeof entry === "boolean") return Buffer.from(`b:${entry ? 1 : 0};`);
    if (typeof entry === "number") {
      if (!Number.isFinite(entry) || (Number.isInteger(entry) && !Number.isSafeInteger(entry))) throw new DecodeError("NUMBER_RANGE", 0);
      return Buffer.from(`${Number.isInteger(entry) ? "i" : "d"}:${entry};`);
    }
    if (Buffer.isBuffer(entry)) return Buffer.concat([Buffer.from(`s:${entry.length}:\"`), entry, Buffer.from('\";')]);
    if (entry.kind !== "array" || entry.entries.length > 100_000) throw new DecodeError("ENTRY_LIMIT", 0);
    return Buffer.concat([Buffer.from(`a:${entry.entries.length}:{`), ...entry.entries.flatMap(([key, child]) => [encode(key, depth + 1), encode(child, depth + 1)]), Buffer.from("}")]);
  };
  const encoded = encode(value, 0);
  if (encoded.length > 16 * 1024 * 1024) throw new DecodeError("PAYLOAD_TOO_LARGE", 0);
  return encoded;
}
export function phpArray(values: Record<string, PhpValue>): PhpArray { return { kind: "array", entries: Object.entries(values).map(([key, value]) => [Buffer.from(key), value]) }; }
