#!/usr/bin/env node
/**
 * Write an ES256 signing JWK for CID_OIDC_SIGNING_KEY.
 * The private key is written to a file and is not printed.
 *
 *   node apps/spectre/scripts/generate-oidc-key.mjs [outfile]
 *
 * Default outfile: oidc-signing-key.jwk in the current directory.
 * Then, from apps/spectre, without printing the file:
 *   npx wrangler secret put CID_OIDC_SIGNING_KEY < oidc-signing-key.jwk
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const out = resolve(process.argv[2] ?? "oidc-signing-key.jwk");
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = privateKey.export({ format: "jwk" });
const kid = createHash("sha256")
  .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
  .digest("base64url")
  .slice(0, 16);
const doc = JSON.stringify({ ...jwk, kid, alg: "ES256", use: "sig" });
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, doc, { mode: 0o600 });
chmodSync(out, 0o600);
console.log(`Wrote signing key file ${out}`);
console.log(`Public key id: ${kid}`);
console.log("The private key was not printed.");
console.log("Set the Worker secret from that file:");
console.log("  npx wrangler secret put CID_OIDC_SIGNING_KEY < " + out);
