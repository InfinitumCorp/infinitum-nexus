/**
 * Sealing account secrets at rest (authenticator-app TOTP seeds), so a copy of the `cid` document or
 * of the cid_accounts table doesn't hand out everyone's second factor.
 *
 * AES-256-GCM with a 32-byte key held outside the data (CID_SECRET_KEY on hosted products, or derived
 * from the Cumulus Tunnel master key). The account's CID is bound in as associated data, so a sealed
 * value copied onto another account doesn't open. Values written before a key was configured stay
 * readable (no prefix) and are sealed the next time they are used.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const PREFIX = "sealed:v1:";

export interface SecretBox {
  seal(plain: string, owner: string): string;
  open(stored: string, owner: string): string;
  /** True for a value written before sealing was on. */
  isPlain(stored: string): boolean;
}

/** A SecretBox over a 32-byte key. */
export function secretBox(key: Buffer): SecretBox {
  if (key.length !== 32) throw new Error("The CID secret key must be 32 bytes");
  return {
    seal(plain, owner) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(owner, "utf8"));
      const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
      return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
    },
    open(stored, owner) {
      if (!stored.startsWith(PREFIX)) return stored;
      const raw = Buffer.from(stored.slice(PREFIX.length), "base64url");
      const d = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      d.setAAD(Buffer.from(owner, "utf8"));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
    },
    isPlain: (stored) => !stored.startsWith(PREFIX),
  };
}

/** Without a key: values are stored as they are, and a sealed value can't be read (it says so). */
export const noSecretBox: SecretBox = {
  seal: (plain) => plain,
  open(stored) {
    if (stored.startsWith(PREFIX)) throw new Error("This account's secret is sealed and no CID secret key is configured");
    return stored;
  },
  isPlain: (stored) => !stored.startsWith(PREFIX),
};

/** A 32-byte key for sealing CID secrets, derived from another master key (e.g. the Cumulus Tunnel key). */
export function deriveCidSecretKey(masterKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "cumulus-id secret box v1", 32));
}

/** CID_SECRET_KEY: 32 bytes, base64 or base64url. Undefined when unset. */
export function cidSecretKeyFromEnv(env: Record<string, string | undefined> = process.env): Buffer | undefined {
  const v = env.CID_SECRET_KEY?.trim();
  if (!v) return undefined;
  const key = Buffer.from(v, "base64");
  if (key.length !== 32) throw new Error("CID_SECRET_KEY must be 32 bytes, base64-encoded");
  return key;
}
