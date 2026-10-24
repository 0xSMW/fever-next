/** Explicit PostgreSQL/JSON boundaries. Never globally coerce pg int8/numeric. */
export const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
export const MAX_CRC32 = 4_294_967_295;
export type IntegerInput = number | bigint | string;

export function safeInteger(value: unknown, label = "integer", minimum = 0, maximum = MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || minimum > maximum) {
    throw new RangeError(`Invalid ${label} bounds`);
  }
  let exact: bigint;
  if (typeof value === "bigint") exact = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) exact = BigInt(value);
  else if (typeof value === "string" && value.length <= 17 && /^-?(?:0|[1-9]\d*)$/.test(value)) exact = BigInt(value);
  else throw new TypeError(`${label} must be an exact integer`);
  if (exact < BigInt(minimum) || exact > BigInt(maximum)) throw new RangeError(`${label} is out of range`);
  return Number(exact);
}

export function toId(value: unknown, label = "id"): number { return safeInteger(value, label, 1); }
export function toScopeId(value: unknown, label = "scope id"): number { return safeInteger(value, label, -1); }
export function toEpochSeconds(value: unknown, label = "epoch seconds"): number { return safeInteger(value, label); }
export function toCount(value: unknown, label = "count"): number { return safeInteger(value, label); }
export function toChecksum(value: unknown, label = "CRC32"): number { return safeInteger(value, label, 0, MAX_CRC32); }
export function nullableId(value: unknown, label = "id"): number | null { return value == null ? null : toId(value, label); }
export function epochNow(): number { return Math.floor(Date.now() / 1000); }
export function dateToEpoch(value: Date | null | undefined): number {
  if (value == null) return 0;
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new RangeError("Invalid date");
  return toEpochSeconds(Math.floor(milliseconds / 1000));
}
export function epochToDate(value: unknown): Date {
  const seconds = toEpochSeconds(value);
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 8_640_000_000_000_000) throw new RangeError("Epoch is outside the Date range");
  return new Date(milliseconds);
}
export function toBoolean(value: unknown, label = "boolean"): boolean {
  if (value === true || value === 1 || value === "1" || value === "t" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "f" || value === "false") return false;
  throw new TypeError(`${label} must be a boolean or 0/1 flag`);
}
export function apiFlag(value: boolean): 0 | 1 {
  if (typeof value !== "boolean") throw new TypeError("API flag requires a boolean");
  return value ? 1 : 0;
}
/** Temperatures are approximate JSON floats; IDs, counts, and clocks must use safeInteger. */
export function toFiniteNumber(value: unknown, label = "number"): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) {
    throw new TypeError(`${label} must be numeric`);
  }
  const result = Number(value);
  if (!Number.isFinite(result)) throw new RangeError(`${label} must be finite`);
  return result;
}
export function toIdList(values: readonly unknown[]): number[] { return values.map((value) => toId(value)); }
export function toIdCsv(values: readonly unknown[]): string { return toIdList(values).join(","); }
