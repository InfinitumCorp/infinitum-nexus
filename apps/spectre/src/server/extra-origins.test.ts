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

test("after the Cumulus://ID cut-over: +SPCTR has its own host and signs in through the issuer", () => {
  // The issuer (InfinitumCorp/cumulus-id) owns id.cumuluscloud.app; a deploy of this Worker that claimed it would take
  // sign-in away from every product. ru.id.cumuluscloud.app is the issuer's mirror, no longer +SPCTR's.
  const config = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
  const json = config.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(json, /"(pattern|SPECTRE_ORIGIN|SPECTRE_EXTRA_ORIGINS)":\s*"[^"]*id\.cumuluscloud\.app/);
  assert.match(json, /"pattern":\s*"spectre\.infinitumcorporation\.ai"/);
  assert.match(json, /"SPECTRE_AUTH":\s*"oidc"/);
  assert.match(config, /"ai":\s*\{\s*"binding":\s*"AI"\s*\}/);
});

test("at the Cumulus://Mail launch: Auto deploy no longer deploys the old Mail Worker onto mail.cumuluscloud.app", () => {
  // mail.cumuluscloud.app moves to InfinitumCorp/cumulus-mail (Worker cumulus-mail-api). A deploy of apps/cumulus-mail,
  // whose config lists that domain, would take it back every time main changes.
  const workflow = readFileSync(new URL("../../../../.github/workflows/auto-deploy.yml", import.meta.url), "utf8");
  const steps = workflow.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(steps, /working-directory:\s*apps\/cumulus-mail/);
  assert.doesNotMatch(steps, /cf deploy/);
});
