/**
 * E(O)N pairing.
 * The wearable and its phone (or another E(O)N) each hold an X25519 key.
 * Both sides derive the same pair of directional keys with HKDF-SHA256 and a
 * short authentication code (SAS) that the wearer compares on both screens
 * to rule out a man in the middle.
 */
import {
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "node:crypto";

export interface EonIdentity {
  deviceId: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export interface PairingKeys {
  /** Key this side encrypts with. */
  sendKey: Buffer;
  /** Key this side decrypts with. */
  receiveKey: Buffer;
  /** 6-digit code both sides show; equal codes mean no interception. */
  sas: string;
  /** Stable id for the paired link (same on both sides). */
  linkId: string;
}

export function createIdentity(deviceId: string): EonIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { deviceId, publicKey, privateKey };
}

export function exportPublicKey(id: EonIdentity): string {
  return id.publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

export function importPublicKey(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(b64, "base64"), type: "spki", format: "der" });
}

/**
 * Derive directional keys. Roles are ordered by public key bytes so both
 * sides agree on which key is "a→b" without extra negotiation.
 */
export function pair(self: EonIdentity, peerPublicKey: KeyObject): PairingKeys {
  const shared = diffieHellman({ privateKey: self.privateKey, publicKey: peerPublicKey });
  const mine = self.publicKey.export({ type: "spki", format: "der" });
  const theirs = peerPublicKey.export({ type: "spki", format: "der" });
  if (mine.equals(theirs)) throw new Error("cannot pair a device with itself");
  const iAmLow = Buffer.compare(mine, theirs) < 0;
  const [low, high] = iAmLow ? [mine, theirs] : [theirs, mine];
  const transcript = createHash("sha256").update(low).update(high).digest();

  const okm = Buffer.from(hkdfSync("sha256", shared, transcript, "E(O)N pairing v1", 64));
  const lowToHigh = okm.subarray(0, 32);
  const highToLow = okm.subarray(32, 64);

  const sasHash = createHash("sha256").update("E(O)N SAS").update(shared).update(transcript).digest();
  const sas = String(sasHash.readUInt32BE(0) % 1_000_000).padStart(6, "0");

  return {
    sendKey: Buffer.from(iAmLow ? lowToHigh : highToLow),
    receiveKey: Buffer.from(iAmLow ? highToLow : lowToHigh),
    sas,
    linkId: transcript.subarray(0, 8).toString("hex"),
  };
}
