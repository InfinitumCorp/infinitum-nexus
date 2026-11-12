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

test("after the Cumulus://ID cut-over the Worker serves +SPCTR only, without the ID mirror", () => {
  const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  // ru.id.cumuluscloud.app belongs to InfinitumCorp/cumulus-id and is not under the new rpId.
  assert.doesNotMatch(config, /"SPECTRE_EXTRA_ORIGINS"/);
  assert.match(config, /"SPECTRE_ORIGIN":\s*"https:\/\/spectre\.infinitumcorporation\.ai"/);
  assert.match(config, /"pattern":\s*"spectre\.infinitumcorporation\.ai"/);
  assert.doesNotMatch(config, /"pattern":\s*"id\.cumuluscloud\.app"/);
  assert.match(config, /"ai":\s*\{\s*"binding":\s*"AI"\s*\}/);
});
