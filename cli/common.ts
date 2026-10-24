import { readFile, stat } from "node:fs/promises";
import { parseArgs } from "node:util";
import { inputFile } from "../lib/migration/files";

export function argumentsFor(names: string[]) {
  return parseArgs({ options: Object.fromEntries(names.map(name => [name, { type: "string" as const }])), allowPositionals: true, strict: true });
}
export function required(values: Record<string, string | boolean | undefined>, key: string): string {
  const value = values[key]; if (typeof value !== "string" || !value) throw new Error(`An explicit --${key} value is required`); return value;
}
export function environment(name: string): string {
  if (!/^[A-Z][A-Z0-9_]+$/.test(name)) throw new Error("Invalid explicitly selected environment variable name");
  const value = process.env[name]; if (!value) throw new Error("The selected environment variable is unset"); return value;
}
/** No automatic .env discovery and no evaluating shell syntax or variable expansion. */
export async function loadExplicitEnvironment(path: string | undefined) {
  if (!path) return;
  const verified = await inputFile(path); const info = await stat(verified);
  if (info.mode & 0o077) throw new Error("Operator env file must have mode 0600");
  if (info.size > 128 * 1024) throw new Error("Operator env file is too large");
  const { parse } = await import("dotenv");
  const values = parse(await readFile(verified));
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]+$/.test(key)) throw new Error("Invalid operator env key");
    if (process.env[key] !== undefined && process.env[key] !== value) throw new Error("Operator env file conflicts with an existing variable; use a clean process environment");
    process.env[key] = value;
  }
}
export function confirmation(values: Record<string, string | boolean | undefined>, action: string, fingerprint: string) {
  if (values.confirm !== `${action}:${fingerprint}`) throw new Error(`Explicit --confirm ${action}:<target-fingerprint> is required`);
}
export function safeFailure(error: unknown) {
  // Database/parser exceptions can include SQL, credentials, and source content.
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "OPERATION_FAILED";
  console.error(JSON.stringify({ ok: false, code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : "OPERATION_FAILED", message: "Operator command failed. No success or cutover is recorded. Inspect the redacted report and the runbook; do not enable writers." }));
  process.exitCode = 1;
}
