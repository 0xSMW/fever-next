import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ConfigurationError, getConfig, requireAuthSecret } from "./config";

const ENVELOPE_VERSION = "fever1";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Domain-separated verifier; plaintext tokens and subjects are never persisted. */
export function tokenHash(token: string, purpose = "token"): string {
  if (!purpose || purpose.includes("\0")) throw new TypeError("A token purpose is required");
  return createHmac("sha256", requireAuthSecret()).update(`fever:${purpose}\0`).update(token).digest("hex");
}

export function randomToken(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 256) throw new RangeError("Invalid token size");
  return randomBytes(bytes).toString("base64url");
}

export function constantTimeEqual(left: string | Buffer, right: string | Buffer): boolean {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left, "utf8");
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function encryptionKey(keyId: string): Buffer {
  const config = getConfig();
  const encoded = Object.prototype.hasOwnProperty.call(config.encryptionKeys, keyId) ? config.encryptionKeys[keyId] : undefined;
  if (!encoded) throw new ConfigurationError("The required encryption key is unavailable");
  return Buffer.from(encoded, "base64");
}

function aad(keyId: string, context: string): Buffer {
  if (!context || context.includes("\0") || Buffer.byteLength(context) > 4096) throw new TypeError("A bounded encryption context is required");
  return Buffer.from(`${ENVELOPE_VERSION}\0${keyId}\0${context}`, "utf8");
}

function decode(value: string, expectedBytes?: number): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid encrypted secret");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || (expectedBytes != null && bytes.length !== expectedBytes)) throw new Error("Invalid encrypted secret");
  return bytes;
}

function envelopeParts(envelope: string): [string, string, string, string, string] {
  const parts = envelope.split(":");
  if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION || !KEY_ID_PATTERN.test(parts[1])) throw new Error("Invalid encrypted secret");
  return parts as [string, string, string, string, string];
}

export function encryptionKeyId(envelope: string): string { return envelopeParts(envelope)[1]; }

/** AES-256-GCM envelope binds the record context and key ID as authenticated data. */
export function encryptSecret(value: string, context: string): string {
  const keyId = getConfig().encryptionKeyId;
  const key = encryptionKey(keyId);
  const nonce = randomBytes(12);
  try {
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(keyId, context));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [ENVELOPE_VERSION, keyId, nonce.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(":");
  } finally { key.fill(0); }
}

export function decryptSecret(envelope: string, context: string): string {
  const [, keyId, nonceText, ciphertextText, tagText] = envelopeParts(envelope);
  const nonce = decode(nonceText, 12);
  const ciphertext = decode(ciphertextText);
  const tag = decode(tagText, 16);
  const key = encryptionKey(keyId);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad(keyId, context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Encrypted secret could not be authenticated");
  } finally { key.fill(0); }
}
