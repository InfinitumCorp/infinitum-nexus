import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// A `cf deploy` without these settings uploads only the Worker code, and mail.cumuluscloud.app/
// (and its ru. mirror) answers 404 while the API keeps working. That shipped once (2026-11-10).
const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("deploy config", () => {
  it("serves the web app in public/ as static assets", () => {
    assert.match(read("../cloudflare.config.ts"), /\bassets:\s*\{/);
    assert.match(read("../wrangler.config.ts"), /assetsDirectory:\s*"\.\/public"/);
    for (const f of ["index.html", "manifest.webmanifest", "app.js", "sw.js"]) {
      assert.ok(existsSync(new URL(`../public/${f}`, import.meta.url)), `public/${f} is missing`);
    }
  });
});
