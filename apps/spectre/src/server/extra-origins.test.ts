import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extraOrigins } from "./vercel.ts";

test("SPECTRE_EXTRA_ORIGINS accepts mirrors under the rpId host only", () => {
  assert.deepEqual(extraOrigins(undefined, "id.cumuluscloud.app"), []);
  assert.deepEqual(extraOrigins(" https://ru.id.cumuluscloud.app/ , ", "id.cumuluscloud.app"), ["https://ru.id.cumuluscloud.app"]);
  assert.throws(() => extraOrigins("https://evil.example", "id.cumuluscloud.app"), /not under/);
  assert.throws(() => extraOrigins("https://xid.cumuluscloud.app", "id.cumuluscloud.app"), /not under/);
});

test("the live Worker config keeps the Russian mirror", () => {
  const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"SPECTRE_EXTRA_ORIGINS":\s*"https:\/\/ru\.id\.cumuluscloud\.app"/);
  assert.match(config, /"ai":\s*\{\s*"binding":\s*"AI"\s*\}/);
});
