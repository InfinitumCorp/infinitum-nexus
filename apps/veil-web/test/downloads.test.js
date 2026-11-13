import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { downloadKey } from "../src/worker.js";

test("downloadKey takes only plain .apk names under /downloads/", () => {
  assert.equal(downloadKey("/downloads/veil-browser.apk"), "veil-browser.apk");
  assert.equal(downloadKey("/downloads/veil-browser-0.8.0.apk"), "veil-browser-0.8.0.apk");
  assert.equal(downloadKey("/downloads/veil-extension.zip"), null);
  assert.equal(downloadKey("/downloads/../secret.apk"), null);
  assert.equal(downloadKey("/downloads/a/b.apk"), null);
  assert.equal(downloadKey("/downloads/.apk"), null);
});

const BYTES = new Uint8Array([80, 75, 3, 4]);
const bucket = {
  async head(key) { return key === "veil-browser.apk" ? { size: BYTES.length, httpEtag: '"e1"' } : null; },
  async get(key) { return key === "veil-browser.apk" ? { size: BYTES.length, httpEtag: '"e1"', body: BYTES } : null; },
};
const env = { DOWNLOADS: bucket };

test("serves the APK from R2 as a download", async () => {
  const res = await worker.fetch(new Request("https://infinitumveil.app/downloads/veil-browser.apk"), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/vnd.android.package-archive");
  assert.match(res.headers.get("content-disposition"), /attachment; filename="veil-browser.apk"/);
  assert.equal(res.headers.get("content-length"), "4");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), BYTES);
});

test("HEAD answers without a body; missing files are 404; other methods 405", async () => {
  const head = await worker.fetch(new Request("https://infinitumveil.app/downloads/veil-browser.apk", { method: "HEAD" }), env);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "4");
  const missing = await worker.fetch(new Request("https://infinitumveil.app/downloads/other.apk"), env);
  assert.equal(missing.status, 404);
  const post = await worker.fetch(new Request("https://infinitumveil.app/downloads/veil-browser.apk", { method: "POST" }), env);
  assert.equal(post.status, 405);
});
