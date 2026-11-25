import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filesFromAssets, workerEntrySource } from "./build-cloudflare.mjs";
import { extractAssetRefs, LIVE_ORIGIN } from "./live-ui.mjs";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(app, "live-ui.manifest.json"), "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

describe("live public UI snapshot", () => {
  it("ignores an example path that appears only in a comment", () => {
    const sample = "/* <script src=\"/assets/cumulus-id.js\"></script> */\nimport x from \"/i18n.js\";";
    const found = extractAssetRefs("/id/button.js", sample, "text/javascript");
    assert.deepEqual(found.refs, ["/i18n.js"]);
    assert.deepEqual(found.dynamic, []);
  });

  it("embeds the captured live bytes and not the repository copy of the home page", () => {
    const files = filesFromAssets(join(app, "live-ui"));
    assert.equal(Object.keys(files).length, manifest.files.length + manifest.added.length);
    // Files the live host doesn't serve yet, embedded from the repository (the account bar).
    for (const row of manifest.added) {
      const body = Buffer.from(files[row.path].body, "base64");
      assert.equal(sha256(body), row.sha256, row.path);
      assert.equal(sha256(readFileSync(join(app, "../..", row.source))), row.sha256, `${row.path} is the repository copy`);
    }
    for (const row of manifest.files) {
      const embedded = files[row.path];
      assert.ok(embedded, row.path);
      const body = Buffer.from(embedded.body, "base64");
      assert.equal(sha256(body), row.sha256, row.path);
      assert.equal(body.length, row.bytes);
    }
    const repoHome = readFileSync(join(app, "public/index.html"));
    const liveHome = manifest.files.find((file) => file.path === "/index.html");
    assert.notEqual(sha256(repoHome), liveHome.sha256);
    const source = workerEntrySource(files);
    assert.match(source, /export \{ NexusStore \}/);
    assert.match(source, /id\/bar\.js/, "the account bar is served");
  });

  it("matches a fresh download of every captured public URL", async () => {
    assert.equal(manifest.origin, LIVE_ORIGIN);
    for (const row of manifest.files) {
      const response = await fetch(LIVE_ORIGIN + row.urlPath, { redirect: "manual" });
      assert.equal(response.status, 200, row.urlPath);
      assert.equal(response.headers.get("location"), null);
      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(sha256(body), row.sha256, row.urlPath);
    }
    for (const row of manifest.excluded) {
      const response = await fetch(LIVE_ORIGIN + row.path, { redirect: "manual" });
      const added = manifest.added.find((a) => a.path === row.path);
      // An added file: the old answer until the next deploy, then exactly the embedded bytes.
      if (added && response.status === 200) assert.equal(sha256(Buffer.from(await response.arrayBuffer())), added.sha256, row.path);
      else assert.equal(response.status, row.status, row.path);
    }
  });
});
