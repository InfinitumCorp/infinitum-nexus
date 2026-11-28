import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskFileStore } from "./files.ts";

test("disk file store: put, get with its type, delete; a key can't leave the directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "mail-files-"));
  const dir = join(root, "files");
  const store = diskFileStore(dir);
  await store.put("d/cid_a/doc/v1.json", new TextEncoder().encode('{"html":"x"}'), "application/json");
  const got = await store.get("d/cid_a/doc/v1.json");
  assert.equal(new TextDecoder().decode(got!.data), '{"html":"x"}');
  assert.equal(got!.type, "application/json");
  assert.equal(await store.get("d/cid_a/doc/missing.json"), null);

  await store.put("../../escape", new Uint8Array([1]), "text/plain");
  assert.equal(existsSync(join(root, "escape")), false, "nothing written outside");
  assert.ok(readdirSync(dir).every((f) => !f.includes("/")), "one flat file per key");

  await store.delete!("d/cid_a/doc/v1.json");
  assert.equal(await store.get("d/cid_a/doc/v1.json"), null);
});
