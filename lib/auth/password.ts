import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Native Node scrypt is the portable password-hash alternative to Argon2id.
 * N=2^17, r=8, p=1 uses roughly 128 MiB per hash. Throttling runs before hashing.
 * The versioned encoding accepts only reviewed costs, so stored input cannot
 * request unbounded work. Imported password bytes are never trimmed or folded.
 */
const COST = 131_072;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_BYTES = 64;
const MAX_PASSWORD_BYTES = 4096;
const PREFIX = `scrypt$1$${COST}$${BLOCK_SIZE}$${PARALLELISM}`;
let activeHashes = 0;
const hashWaiters: Array<() => void> = [];

async function derive(password: string | Buffer, salt: Buffer): Promise<Buffer> {
  // Each hash needs about 128 MiB. Bound both execution and the in-process queue.
  if (activeHashes >= 2) {
    if (hashWaiters.length >= 8) throw new Error("Password verification is temporarily busy.");
    await new Promise<void>((resolve) => hashWaiters.push(resolve));
  } else activeHashes += 1;
  try { return await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, {
      N: COST,
      r: BLOCK_SIZE,
      p: PARALLELISM,
      maxmem: 256 * 1024 * 1024,
    }, (error, key) => error ? reject(error) : resolve(key));
  }); } finally {
    const next = hashWaiters.shift();
    if (next) next();
    else activeHashes -= 1;
  }
}

export function passwordHasSupportedSize(password: unknown): password is string {
  return typeof password === "string" && Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES;
}

export function validateNewPassword(password: unknown): asserts password is string {
  if (!passwordHasSupportedSize(password) || [...password].length < 12 || Buffer.byteLength(password, "utf8") > 1024) {
    throw new Error("Use a password of at least 12 characters and at most 1,024 UTF-8 bytes.");
  }
}

/** Also used by the offline importer; minimum length applies only to new passwords. */
export async function hashPassword(password: string | Buffer): Promise<string> {
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) throw new Error("Password exceeds the supported byte limit.");
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `${PREFIX}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string | Buffer, encoded: string): Promise<boolean> {
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) return false;
  const pieces = encoded.split("$");
  if (pieces.length !== 7 || pieces.slice(0, 5).join("$") !== PREFIX ||
      !/^[a-f0-9]{32}$/.test(pieces[5]) || !/^[a-f0-9]{128}$/.test(pieces[6])) return false;
  const expected = Buffer.from(pieces[6], "hex");
  const actual = await derive(password, Buffer.from(pieces[5], "hex"));
  return timingSafeEqual(actual, expected);
}

/** Same cost for an unknown login; this is never an account's stored hash. */
export async function consumeDummyPasswordWork(password: string): Promise<void> {
  await derive(password, Buffer.alloc(16));
}
