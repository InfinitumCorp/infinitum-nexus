import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const script = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/generate-oidc-key.mjs");

describe("generate-oidc-key", () => {
  it("writes a private JWK and does not print it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cid-oidc-"));
    const file = join(dir, "key.jwk");
    try {
      const run = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      const out = `${run.stdout}\n${run.stderr}`;
      assert.match(out, /The private key was not printed/);
      assert.doesNotMatch(out, /"d"\s*:/);
      const jwk = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(jwk.kty, "EC");
      assert.equal(jwk.alg, "ES256");
      assert.equal(typeof jwk.d, "string");
      assert.equal(out.includes(jwk.d), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
