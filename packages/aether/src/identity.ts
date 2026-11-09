/**
 * ÆTHER device identity: an Ed25519 key pair whose raw public key is the node address.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;

export interface Identity {
  /** Raw 32-byte Ed25519 public key; this is the node address. */
  readonly publicKey: Uint8Array;
  /** Hex of the public key. */
  readonly id: string;
  sign(data: Uint8Array): Uint8Array;
}

class Ed25519Identity implements Identity {
  readonly publicKey: Uint8Array;
  readonly id: string;
  readonly #privateKey: KeyObject;

  constructor(privateKey: KeyObject) {
    this.#privateKey = privateKey;
    this.publicKey = rawPublicKey(createPublicKey(privateKey));
    this.id = toHex(this.publicKey);
  }

  sign(data: Uint8Array): Uint8Array {
    return new Uint8Array(sign(null, data, this.#privateKey));
  }
}

export function createIdentity(): Identity {
  const { privateKey } = generateKeyPairSync("ed25519");
  return new Ed25519Identity(privateKey);
}

/** Restore an identity from a PKCS#8 DER private key (as stored by the app's keystore wrapper). */
export function identityFromPkcs8(der: Uint8Array): Identity {
  return new Ed25519Identity(createPrivateKey({ key: Buffer.from(der), format: "der", type: "pkcs8" }));
}

const verifyKeyCache = new Map<string, KeyObject>();
const VERIFY_KEY_CACHE_MAX = 4096;

function publicKeyObject(raw: Uint8Array): KeyObject {
  const id = toHex(raw);
  let key = verifyKeyCache.get(id);
  if (!key) {
    key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
    if (verifyKeyCache.size >= VERIFY_KEY_CACHE_MAX) {
      const oldest = verifyKeyCache.keys().next().value;
      if (oldest !== undefined) verifyKeyCache.delete(oldest);
    }
    verifyKeyCache.set(id, key);
  }
  return key;
}

export function verifySignature(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== PUBLIC_KEY_BYTES || signature.length !== SIGNATURE_BYTES) return false;
  try {
    return verify(null, data, publicKeyObject(publicKey), signature);
  } catch {
    return false;
  }
}

function rawPublicKey(key: KeyObject): Uint8Array {
  const jwk = key.export({ format: "jwk" });
  if (typeof jwk.x !== "string") throw new Error("not an Ed25519 key");
  return new Uint8Array(Buffer.from(jwk.x, "base64url"));
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function shortId(idOrKey: string | Uint8Array): string {
  const hex = typeof idOrKey === "string" ? idOrKey : toHex(idOrKey);
  return hex.slice(0, 16);
}
