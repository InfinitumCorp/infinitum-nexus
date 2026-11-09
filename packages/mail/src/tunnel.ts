/**
 * Cumulus Tunnel: encryption between Cumulus://ID accounts, with no keys for people to manage.
 *
 * Every Cumulus://ID gets two key pairs the moment its mailbox is created:
 * - X25519 for sealing (only that account's key opens what is sealed to it),
 * - Ed25519 for signing (proves which Cumulus account sealed a message).
 *
 * A message from one Cumulus account to another is sealed for the recipient and signed by the
 * sender. The recipient's copy is produced only by opening that envelope, so what arrives is exactly
 * what the sender's account sealed, and the signature is checked on the way in.
 *
 * Sealing: a fresh 256-bit content key encrypts the payload with AES-256-GCM. For each recipient an
 * ephemeral X25519 key agrees a secret with the recipient's public key; HKDF-SHA256 turns it into a
 * key-wrapping key that encrypts the content key (AES-256-GCM). The sender signs the whole envelope.
 *
 * Private keys never leave the server unencrypted: they are stored wrapped with the platform master
 * key (AES-256-GCM). People never see or handle keys. Because the platform holds them on people's
 * behalf, this protects mail in transit between accounts and at rest, but it is not end-to-end against
 * the operator itself; device-held keys (for example, derived from a passkey) would be the next step.
 */
import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject,
} from "node:crypto";

export const TUNNEL_VERSION = 1;
const INFO = "cumulus-tunnel/v1";

interface Wrapped { iv: string; ct: string; tag: string }

export interface StoredTunnelKeys {
  cid: string;
  createdAt: string;
  /** X25519 public key, SPKI DER, base64. */
  boxPublic: string;
  /** Ed25519 public key, SPKI DER, base64. */
  signPublic: string;
  /** Both private keys (PKCS#8 DER), wrapped with the master key. */
  wrapped: Wrapped;
}

export class TunnelStore {
  keys = new Map<string, StoredTunnelKeys>();
}

export interface SealedEnvelope {
  v: number;
  /** Sender CID. */
  from: string;
  iv: string;
  ct: string;
  tag: string;
  /** Content key, wrapped for each recipient CID. */
  keys: Record<string, { epk: string; iv: string; ct: string; tag: string }>;
  /** Sender's Ed25519 signature over everything above. */
  sig: string;
}

export interface OpenedEnvelope<T> {
  payload: T;
  from: string;
  verified: boolean;
}

export class TunnelError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");

function gcmEncrypt(key: Buffer, plain: Buffer, aad: string): Wrapped {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv: b64(iv), ct: b64(ct), tag: b64(c.getAuthTag()) };
}

function gcmDecrypt(key: Buffer, w: Wrapped, aad: string): Buffer {
  const d = createDecipheriv("aes-256-gcm", key, unb64(w.iv));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(unb64(w.tag));
  return Buffer.concat([d.update(unb64(w.ct)), d.final()]);
}

/** Bytes the sender signs: every field except the signature, in a fixed order. */
function signedBytes(env: Omit<SealedEnvelope, "sig">): Buffer {
  const keys = Object.keys(env.keys).sort().map((cid) => [cid, env.keys[cid]!.epk, env.keys[cid]!.iv, env.keys[cid]!.ct, env.keys[cid]!.tag]);
  return Buffer.from(JSON.stringify([env.v, env.from, env.iv, env.ct, env.tag, keys]));
}

/** A 32-byte master key from base64 (for example CUMULUS_MAIL_MASTER_KEY). */
export function parseMasterKey(value: string): Buffer {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32) throw new TunnelError("bad_master_key", "The tunnel master key must be 32 bytes, base64-encoded.");
  return key;
}

export function generateMasterKey(): string {
  return b64(randomBytes(32));
}

export interface TunnelOptions {
  store?: TunnelStore;
  /** 32-byte key that wraps every account's private keys. Without one, keys live only in this process. */
  masterKey?: Buffer;
  clock?: () => Date;
}

export class CumulusTunnel {
  readonly store: TunnelStore;
  /** True when a persistent master key was supplied, so sealed data survives a restart. */
  readonly persistent: boolean;
  private readonly master: Buffer;
  private readonly clock: () => Date;
  private readonly unwrapped = new Map<string, { box: KeyObject; sign: KeyObject }>();

  constructor(opts: TunnelOptions = {}) {
    this.persistent = Boolean(opts.masterKey);
    if (opts.masterKey && opts.masterKey.length !== 32) throw new TunnelError("bad_master_key", "The tunnel master key must be 32 bytes.");
    this.master = opts.masterKey ?? randomBytes(32);
    // Keys wrapped with a key that dies with the process can't be reused later, so start clean.
    this.store = opts.store ?? new TunnelStore();
    if (!this.persistent) this.store.keys.clear();
    this.clock = opts.clock ?? (() => new Date());
  }

  /** Create the account's keys if it has none. Idempotent. */
  ensure(cid: string): StoredTunnelKeys {
    const existing = this.store.keys.get(cid);
    if (existing) return existing;
    const box = generateKeyPairSync("x25519");
    const sig = generateKeyPairSync("ed25519");
    const privates = Buffer.from(JSON.stringify({
      box: b64(box.privateKey.export({ type: "pkcs8", format: "der" })),
      sign: b64(sig.privateKey.export({ type: "pkcs8", format: "der" })),
    }));
    const record: StoredTunnelKeys = {
      cid,
      createdAt: this.clock().toISOString(),
      boxPublic: b64(box.publicKey.export({ type: "spki", format: "der" })),
      signPublic: b64(sig.publicKey.export({ type: "spki", format: "der" })),
      wrapped: gcmEncrypt(this.master, privates, `${INFO}/keys/${cid}`),
    };
    this.store.keys.set(cid, record);
    this.unwrapped.set(cid, { box: box.privateKey, sign: sig.privateKey });
    return record;
  }

  has(cid: string) {
    return this.store.keys.has(cid);
  }

  /** Short, human-comparable fingerprint of an account's tunnel keys (like a safety number). */
  fingerprint(cid: string): string {
    const k = this.store.keys.get(cid);
    if (!k) return "";
    const hex = createHash("sha256").update(unb64(k.boxPublic)).update(unb64(k.signPublic)).digest("hex").slice(0, 24).toUpperCase();
    return hex.match(/.{4}/g)!.join(" ");
  }

  private privateKeys(cid: string) {
    const cached = this.unwrapped.get(cid);
    if (cached) return cached;
    const k = this.store.keys.get(cid);
    if (!k) throw new TunnelError("no_keys", "This Cumulus://ID has no tunnel keys.");
    let raw: { box: string; sign: string };
    try {
      raw = JSON.parse(gcmDecrypt(this.master, k.wrapped, `${INFO}/keys/${cid}`).toString("utf8"));
    } catch {
      throw new TunnelError("locked", "These keys were wrapped with a different master key.");
    }
    const keys = {
      box: createPrivateKey({ key: unb64(raw.box), format: "der", type: "pkcs8" }),
      sign: createPrivateKey({ key: unb64(raw.sign), format: "der", type: "pkcs8" }),
    };
    this.unwrapped.set(cid, keys);
    return keys;
  }

  private kek(shared: Buffer, epk: string, recipient: string) {
    return Buffer.from(hkdfSync("sha256", shared, unb64(epk), `${INFO}/kek/${recipient}`, 32));
  }

  /** Seal a payload from one account to one or more accounts (include the sender to keep a readable copy). */
  seal<T>(fromCid: string, toCids: string[], payload: T): SealedEnvelope {
    const signKey = this.privateKeys(fromCid).sign;
    const cek = randomBytes(32);
    const body = gcmEncrypt(cek, Buffer.from(JSON.stringify(payload)), `${INFO}/body/${fromCid}`);
    const keys: SealedEnvelope["keys"] = {};
    for (const to of new Set(toCids)) {
      const rk = this.store.keys.get(to);
      if (!rk) throw new TunnelError("no_keys", "That Cumulus://ID has no tunnel keys.");
      const eph = generateKeyPairSync("x25519");
      const epk = b64(eph.publicKey.export({ type: "spki", format: "der" }));
      const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: unb64(rk.boxPublic), format: "der", type: "spki" }) });
      keys[to] = { epk, ...gcmEncrypt(this.kek(shared, epk, to), cek, `${INFO}/cek/${fromCid}/${to}`) };
    }
    const unsigned = { v: TUNNEL_VERSION, from: fromCid, ...body, keys };
    return { ...unsigned, sig: b64(sign(null, signedBytes(unsigned), signKey)) };
  }

  /** Open an envelope sealed to `cid`. Throws if it wasn't sealed to this account or was altered. */
  open<T>(cid: string, env: SealedEnvelope): OpenedEnvelope<T> {
    if (env?.v !== TUNNEL_VERSION) throw new TunnelError("bad_envelope", "Unknown tunnel envelope version.");
    const slot = env.keys[cid];
    if (!slot) throw new TunnelError("not_for_you", "This message wasn't sealed to this Cumulus://ID.");
    const sender = this.store.keys.get(env.from);
    const { sig, ...unsigned } = env;
    const verified = Boolean(sender) && verify(null, signedBytes(unsigned), createPublicKey({ key: unb64(sender!.signPublic), format: "der", type: "spki" }), unb64(sig));
    if (sender && !verified) throw new TunnelError("bad_signature", "The sender's signature doesn't match. The message was altered.");
    try {
      const shared = diffieHellman({ privateKey: this.privateKeys(cid).box, publicKey: createPublicKey({ key: unb64(slot.epk), format: "der", type: "spki" }) });
      const cek = gcmDecrypt(this.kek(shared, slot.epk, cid), slot, `${INFO}/cek/${env.from}/${cid}`);
      const payload = JSON.parse(gcmDecrypt(cek, env, `${INFO}/body/${env.from}`).toString("utf8")) as T;
      return { payload, from: env.from, verified };
    } catch (err) {
      if (err instanceof TunnelError) throw err;
      throw new TunnelError("cannot_open", "This message couldn't be decrypted.");
    }
  }
}
