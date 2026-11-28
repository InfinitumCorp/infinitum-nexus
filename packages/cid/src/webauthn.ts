import { createHash, createPublicKey, verify, type KeyObject, type webcrypto } from "node:crypto";

// @types/node 26 exposes JsonWebKey only under webcrypto.
type JsonWebKey = webcrypto.JsonWebKey;
import { decodeCbor, type CborValue } from "./cbor.ts";

/**
 * WebAuthn relying-party verification for CID passkeys and security keys.
 * Supports ES256 (P-256), EdDSA (Ed25519) and RS256 credentials with "none" attestation,
 * which is what passkey providers return when no attestation is requested.
 */

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const fromB64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

const FLAG_UP = 0x01; // user present
const FLAG_UV = 0x04; // user verified (biometric / PIN)
const FLAG_BE = 0x08; // backup eligible (synced passkey)
const FLAG_BS = 0x10; // backed up
const FLAG_AT = 0x40; // attested credential data included

export const COSE_ALG = { ES256: -7, EdDSA: -8, RS256: -257 } as const;

export interface AuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  signCount: number;
  credentialId?: Uint8Array;
  publicKeyCose?: Uint8Array;
}

export function parseAuthenticatorData(data: Uint8Array): AuthenticatorData {
  if (data.length < 37) throw new Error("WebAuthn: authenticator data too short");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const result: AuthenticatorData = {
    rpIdHash: data.slice(0, 32),
    flags: data[32],
    signCount: view.getUint32(33),
  };
  if (result.flags & FLAG_AT) {
    let pos = 37 + 16; // skip AAGUID
    const idLen = view.getUint16(pos);
    pos += 2;
    result.credentialId = data.slice(pos, pos + idLen);
    pos += idLen;
    const { offset } = decodeCbor(data, pos);
    result.publicKeyCose = data.slice(pos, offset);
  }
  return result;
}

export function coseToKey(cose: Uint8Array): { key: KeyObject; alg: number } {
  const { value } = decodeCbor(cose);
  if (!(value instanceof Map)) throw new Error("WebAuthn: credential key is not a COSE map");
  const get = (k: number) => value.get(k) as CborValue;
  const kty = get(1);
  const alg = get(3) as number;
  let jwk: JsonWebKey;
  if (kty === 2 && get(-1) === 1 && alg === COSE_ALG.ES256) {
    jwk = { kty: "EC", crv: "P-256", x: b64u(get(-2) as Uint8Array), y: b64u(get(-3) as Uint8Array) };
  } else if (kty === 1 && get(-1) === 6 && alg === COSE_ALG.EdDSA) {
    jwk = { kty: "OKP", crv: "Ed25519", x: b64u(get(-2) as Uint8Array) };
  } else if (kty === 3 && alg === COSE_ALG.RS256) {
    jwk = { kty: "RSA", n: b64u(get(-1) as Uint8Array), e: b64u(get(-2) as Uint8Array) };
  } else {
    throw new Error("WebAuthn: unsupported credential algorithm");
  }
  return { key: createPublicKey({ key: jwk as any, format: "jwk" }), alg };
}

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

function checkClientData(clientDataJSON: string, type: string, challenge: string, origins: string[]): ClientData {
  const cd = JSON.parse(Buffer.from(clientDataJSON, "base64url").toString("utf8")) as ClientData;
  if (cd.type !== type) throw new Error("WebAuthn: wrong ceremony type");
  if (cd.challenge !== challenge) throw new Error("WebAuthn: challenge mismatch");
  if (!origins.includes(cd.origin)) throw new Error("WebAuthn: origin not allowed");
  if (cd.crossOrigin) throw new Error("WebAuthn: cross-origin ceremonies are not allowed");
  return cd;
}

function checkFlags(ad: AuthenticatorData, rpId: string, requireUV: boolean) {
  if (Buffer.compare(Buffer.from(ad.rpIdHash), Buffer.from(sha256(new TextEncoder().encode(rpId)))) !== 0) {
    throw new Error("WebAuthn: credential was created for a different site");
  }
  if (!(ad.flags & FLAG_UP)) throw new Error("WebAuthn: user presence not confirmed");
  if (requireUV && !(ad.flags & FLAG_UV)) throw new Error("WebAuthn: user verification required");
}

export interface RegistrationResponse {
  clientDataJSON: string; // base64url
  attestationObject: string; // base64url
}

export interface VerifiedCredential {
  credentialId: string;
  publicKeyCose: string;
  alg: number;
  signCount: number;
  userVerified: boolean;
  /** True for synced passkeys (iCloud Keychain, Google Password Manager, etc.). */
  backupEligible: boolean;
  backedUp: boolean;
}

export function verifyRegistration(
  response: RegistrationResponse,
  expected: { challenge: string; origins: string[]; rpId: string; requireUserVerification?: boolean },
): VerifiedCredential {
  checkClientData(response.clientDataJSON, "webauthn.create", expected.challenge, expected.origins);
  const { value } = decodeCbor(fromB64u(response.attestationObject));
  if (!(value instanceof Map)) throw new Error("WebAuthn: malformed attestation object");
  if (value.get("fmt") !== "none") throw new Error("WebAuthn: only 'none' attestation is accepted");
  const ad = parseAuthenticatorData(value.get("authData") as Uint8Array);
  checkFlags(ad, expected.rpId, expected.requireUserVerification ?? false);
  if (!ad.credentialId || !ad.publicKeyCose) throw new Error("WebAuthn: no credential in response");
  const { alg } = coseToKey(ad.publicKeyCose); // rejects unsupported keys up front
  return {
    credentialId: b64u(ad.credentialId),
    publicKeyCose: b64u(ad.publicKeyCose),
    alg,
    signCount: ad.signCount,
    userVerified: Boolean(ad.flags & FLAG_UV),
    backupEligible: Boolean(ad.flags & FLAG_BE),
    backedUp: Boolean(ad.flags & FLAG_BS),
  };
}

/** True when `sig` is a well-formed ASN.1 DER ECDSA-Sig-Value: SEQUENCE { INTEGER r, INTEGER s }. */
export function isDerEcdsaSignature(sig: Uint8Array): boolean {
  if (sig.length < 8 || sig.length > 72 || sig[0] !== 0x30 || sig[1] !== sig.length - 2) return false;
  let pos = 2;
  for (let i = 0; i < 2; i++) {
    if (sig[pos] !== 0x02) return false;
    const len = sig[pos + 1];
    if (len < 1 || len > 33 || pos + 2 + len > sig.length) return false;
    pos += 2 + len;
  }
  return pos === sig.length;
}

/**
 * ES256 assertion signatures are ASN.1 DER (WebAuthn §6.5.6), which is what real passkeys and
 * security keys send. A raw 64-byte r||s (IEEE P1363) is still accepted for credentials signed
 * by older test tooling. DER key bytes rather than { key: KeyObject }: Cloudflare Workers
 * accept only the former.
 */
function verifyEs256(signed: Uint8Array, key: KeyObject, sig: Buffer): boolean {
  const spki = key.export({ type: "spki", format: "der" });
  const check = (dsaEncoding: "der" | "ieee-p1363") => {
    try {
      return verify("sha256", signed, { key: spki, format: "der", type: "spki", dsaEncoding }, sig);
    } catch {
      return false;
    }
  };
  if (isDerEcdsaSignature(sig) && check("der")) return true;
  return sig.length === 64 && check("ieee-p1363");
}

export interface AssertionResponse {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

export function verifyAssertion(
  response: AssertionResponse,
  credential: { publicKeyCose: string; signCount: number },
  expected: { challenge: string; origins: string[]; rpId: string; requireUserVerification?: boolean },
): { signCount: number; userVerified: boolean } {
  checkClientData(response.clientDataJSON, "webauthn.get", expected.challenge, expected.origins);
  const authData = fromB64u(response.authenticatorData);
  const ad = parseAuthenticatorData(authData);
  checkFlags(ad, expected.rpId, expected.requireUserVerification ?? false);

  const signed = Buffer.concat([authData, sha256(fromB64u(response.clientDataJSON))]);
  const { key, alg } = coseToKey(fromB64u(credential.publicKeyCose));
  const sig = Buffer.from(response.signature, "base64url");
  const ok = alg === COSE_ALG.EdDSA
    ? verify(null, signed, key, sig)
    : alg === COSE_ALG.ES256
      ? verifyEs256(signed, key, sig)
      : verify("sha256", signed, key, sig); // RS256 is PKCS#1 v1.5.
  if (!ok) throw new Error("WebAuthn: signature check failed");

  // A counter that fails to increase signals a cloned authenticator. Synced passkeys report 0.
  if ((ad.signCount > 0 || credential.signCount > 0) && ad.signCount <= credential.signCount) {
    throw new Error("WebAuthn: signature counter did not increase (possible cloned key)");
  }
  return { signCount: ad.signCount, userVerified: Boolean(ad.flags & FLAG_UV) };
}

