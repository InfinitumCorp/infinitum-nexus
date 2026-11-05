/**
 * Encrypts provider credentials (Plaid access tokens, broker API keys) at rest.
 *
 * AES-256-GCM with a 32-byte key from METATRON_VAULT_KEY. Each sealed value is bound to
 * "additional authenticated data" (the owner's CID and the connection id), so a ciphertext
 * copied into another user's record fails to decrypt instead of granting access.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface Sealed {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

export class Vault {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64 ?? "", "base64");
    if (key.length !== 32) throw new Error("METATRON_VAULT_KEY must be 32 random bytes, base64-encoded");
    this.key = key;
  }

  /** A fresh key for setup: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. */
  static generateKey(): string {
    return randomBytes(32).toString("base64");
  }

  seal(plain: string, aad: string): Sealed {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(Buffer.from(aad));
    const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  open(sealed: Sealed, aad: string): string {
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(sealed.iv, "base64"));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(sealed.data, "base64")), d.final()]).toString("utf8");
  }
}
