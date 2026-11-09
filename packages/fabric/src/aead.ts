/**
 * FABRIC AEAD.
 * Scaffold uses Node crypto for AES-256-GCM.
 * Production would derive keys via X25519 and use a dedicated library.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGO = "aes-256-gcm";

/** 32-byte AES-256 key. */
export function randomKey(): Buffer {
  return randomBytes(32);
}

/**
 * Encrypt with a raw 32-byte key.
 * Layout is base64(iv || tag || ciphertext). Optional AAD is bound into the tag.
 */
export function seal(plaintext: string, key: Uint8Array, aad?: string): string {
  const raw = aesKey(key);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, raw, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/** Decrypt a payload from {@link seal}. AAD must match the value used to seal. */
export function open(payload: string, key: Uint8Array, aad?: string): string {
  const raw = aesKey(key);
  const buf = Buffer.from(payload, "base64");
  if (buf.length < 28) throw new Error("FABRIC payload is truncated");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, raw, iv);
  decipher.setAuthTag(tag);
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

function aesKey(key: Uint8Array): Buffer {
  const raw = Buffer.from(key);
  if (raw.length !== 32) throw new Error("FABRIC key must be 32 bytes");
  return raw;
}

export function encryptAead(plaintext: string, password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, enc]).toString("base64");
}

export function decryptAead(payload: string, password: string): string {
  const buf = Buffer.from(payload, "base64");
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const enc = buf.subarray(44);
  const key = scryptSync(password, salt, 32);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
