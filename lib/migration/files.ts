import { constants, createReadStream } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";

export async function inputFile(path: string): Promise<string> {
  if (!path || !isAbsolute(path)) throw new Error("An explicit absolute input path is required");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Input must be a regular file, not a symlink");
  return realpath(path);
}
/** Atomic exclusive creation; never overwrite a snapshot, backup, or operator evidence. */
export async function newRestrictedFile(path: string) {
  if (!path || !isAbsolute(path) || resolve(path) !== path) throw new Error("An explicit normalized absolute output path is required");
  const parent = await realpath(dirname(path));
  const info = await stat(parent);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error("Output parent must be a private directory (mode 0700)");
  if (parent !== dirname(path)) throw new Error("Output parent may not traverse symlinks");
  return open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
}
export async function writeRestrictedJson(path: string, data: unknown) {
  const file = await newRestrictedFile(path);
  try { await file.writeFile(JSON.stringify(data, null, 2) + "\n"); await file.sync(); } finally { await file.close(); }
}
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(await inputFile(path))) hash.update(chunk);
  return hash.digest("hex");
}
export async function* boundedLines(path: string, maxLineBytes = 24 * 1024 * 1024): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const part of createReadStream(await inputFile(path))) {
    pending = Buffer.concat([pending, part as Buffer]);
    let end: number;
    while ((end = pending.indexOf(10)) >= 0) {
      if (end > maxLineBytes) throw new Error("Snapshot line exceeds the configured bound");
      yield new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, end));
      pending = pending.subarray(end + 1);
    }
    if (pending.length > maxLineBytes) throw new Error("Snapshot line exceeds the configured bound");
  }
  if (pending.length) throw new Error("Snapshot is truncated (missing final newline)");
}
