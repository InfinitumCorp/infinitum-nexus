/**
 * Download pinned v2fly geoip.dat and geosite.dat into data/geo/.
 * Checks each file against the official .sha256sum asset and geo-dat.lock.json.
 * A mismatch deletes the download and exits. The binaries are not committed.
 *
 *   node scripts/fetch-geo-dat.mjs
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outDir = join(root, "data", "geo");

export function parseSha256Sum(text, filename) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})(?:\s+\*?(\S+))?$/i);
    if (!match) continue;
    if (!match[2] || match[2] === filename || match[2].endsWith("/" + filename)) return match[1].toLowerCase();
  }
  throw new Error(`official checksum for ${filename} was not in the .sha256sum asset`);
}

export function assertSameHash(label, actual, official, locked) {
  const got = String(actual).toLowerCase();
  const published = String(official).toLowerCase();
  const pin = String(locked).toLowerCase();
  if (got === published && got === pin) return;
  const error = new Error(
    `${label} SHA-256 mismatch\n  downloaded: ${got}\n  official:   ${published}\n  lockfile:   ${pin}`,
  );
  error.code = "GEO_DAT_HASH_MISMATCH";
  throw error;
}

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchEntry(entry) {
  const officialText = new TextDecoder().decode(await download(entry.sha256sumUrl));
  const official = parseSha256Sum(officialText, entry.asset);
  const bytes = await download(entry.url);
  const actual = createHash("sha256").update(bytes).digest("hex");
  assertSameHash(entry.filename, actual, official, entry.sha256);
  return bytes;
}

async function main() {
  const lock = JSON.parse(readFileSync(join(root, "geo-dat.lock.json"), "utf8"));
  mkdirSync(outDir, { recursive: true });
  for (const key of ["geoip", "geosite"]) {
    const entry = lock[key];
    const dest = join(outDir, entry.filename);
    const tmp = dest + ".partial";
    try {
      const bytes = await fetchEntry(entry);
      writeFileSync(tmp, bytes);
      renameSync(tmp, dest);
      console.log(`${entry.filename} sha256 ${entry.sha256} -> data/geo/${entry.filename}`);
    } catch (err) {
      rmSync(tmp, { force: true });
      rmSync(dest, { force: true });
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
      return;
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

export { dirname };
