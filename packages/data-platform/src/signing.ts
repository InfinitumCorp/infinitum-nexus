// © Infinitum Corporation®. All rights reserved.
/**
 * Request signing between a product backend and the collection gateway.
 *
 *   x-infinitum-key        key id of the product credential
 *   x-infinitum-timestamp  unix seconds
 *   x-infinitum-nonce      16-64 random hex characters, unique per request (replay guard)
 *   x-infinitum-signature  hex HMAC-SHA256(secret, "v1\n" + timestamp + "\n" + nonce + "\n" + body)
 *
 * Product credentials are server-side secrets. Browser and mobile clients send through
 * their product's backend, which authenticates the person with Cumulus ID first.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNATURE_VERSION = "v1";

export function sign(secret: string, timestamp: number, nonce: string, body: string): string {
  return createHmac("sha256", secret).update([SIGNATURE_VERSION, String(timestamp), nonce, body].join("\n")).digest("hex");
}

export function verify(secret: string, timestamp: number, nonce: string, body: string, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(signature) || !/^[0-9a-f]{16,64}$/.test(nonce)) return false;
  const want = Buffer.from(sign(secret, timestamp, nonce, body), "hex");
  return timingSafeEqual(want, Buffer.from(signature, "hex"));
}

export function signedHeaders(keyId: string, secret: string, body: string, now = Date.now()): Record<string, string> {
  const ts = Math.floor(now / 1000);
  const nonce = randomBytes(16).toString("hex");
  return {
    "content-type": "application/json",
    "x-infinitum-key": keyId,
    "x-infinitum-timestamp": String(ts),
    "x-infinitum-nonce": nonce,
    "x-infinitum-signature": sign(secret, ts, nonce, body),
  };
}
