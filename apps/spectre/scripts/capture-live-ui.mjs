#!/usr/bin/env node
/**
 * Download the public files id.cumuluscloud.app serves and write apps/spectre/live-ui plus
 * live-ui.manifest.json. Seeds are `/` and every file in public/. A public/ file the host does
 * not serve is recorded as excluded and is not written. Referenced assets are followed.
 * A referenced asset that is not HTTP 200 aborts. Nothing is guessed past that.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectLiveUi, LIVE_ORIGIN, repoPublicPaths } from "./live-ui.mjs";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(app, "live-ui");
const seeds = ["/", ...repoPublicPaths(join(app, "public"))];
const inventory = await collectLiveUi(LIVE_ORIGIN, seeds);
const again = await collectLiveUi(LIVE_ORIGIN, inventory.files.map((file) => file.urlPath));
for (const file of inventory.files) {
  const second = again.files.find((item) => item.path === file.path);
  if (!second || second.sha256 !== file.sha256) {
    throw new Error(`${file.path} changed between two fetches`);
  }
}
rmSync(outDir, { recursive: true, force: true });
for (const file of inventory.files) {
  const target = join(outDir, file.path.slice(1));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, file.body);
}
const probedNotEmbedded = [];
const probeNotes = {
  "/robots.txt": "Well-known URL. Body is a content-signal policy, not referenced by the application and not a file in public/. Not embedded.",
  "/favicon.ico": "Browsers request this. The pages reference /favicon.svg instead. Live response is the Worker's JSON 404. Not embedded.",
  "/manifest.webmanifest": "Not referenced by the pages. Live response is the Worker's JSON 404. Not embedded.",
};
for (const path of Object.keys(probeNotes)) {
  const response = await fetch(`${LIVE_ORIGIN}${path}`, { redirect: "manual" });
  const body = Buffer.from(await response.arrayBuffer());
  probedNotEmbedded.push({
    path,
    status: response.status,
    contentType: response.headers.get("content-type"),
    sha256: response.status === 200 ? createHash("sha256").update(body).digest("hex") : null,
    note: probeNotes[path],
  });
}
const manifest = {
  origin: LIVE_ORIGIN,
  capturedFrom: "public URLs only; two fetches, hashes matched",
  files: inventory.files.map(({ body: _body, ...rest }) => rest),
  excluded: inventory.excluded,
  probedNotEmbedded,
};
writeFileSync(join(app, "live-ui.manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${inventory.files.length} live files, excluded ${inventory.excluded.length}`);
