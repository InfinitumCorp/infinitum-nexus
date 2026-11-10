import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readDriveConfig } from "./config.ts";
import { MasterKey, decryptPlaintext, encryptPlaintext, readAll, sha256 } from "./crypto.ts";
import { DriveError } from "./errors.ts";
import { LocalFsBlobStore } from "./local-driver.ts";
import { cleanName } from "./names.ts";
import { RateLimiter } from "./rate-limit.ts";
import { assertLocalDriver } from "./s3-driver.ts";
import { sniff } from "./sniff.ts";
import { splitSql } from "./db.ts";

test("sniff serves HTML and SVG as an attachment type", () => {
  const html = sniff(Buffer.from("<!DOCTYPE html><script>alert(1)</script>"), "text/html");
  assert.equal(html.mediaType, "application/octet-stream");
  assert.equal(html.inline, false);
  const svg = sniff(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "image/svg+xml");
  assert.equal(svg.mediaType, "application/octet-stream");
  const png = sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), "application/octet-stream");
  assert.equal(png.mediaType, "image/png");
  assert.equal(png.inline, true);
});

test("names reject path segments", () => {
  assert.equal(cleanName(" notes.txt "), "notes.txt");
  assert.throws(() => cleanName("../x"), DriveError);
  assert.throws(() => cleanName("a/b"), DriveError);
  assert.throws(() => cleanName("."), DriveError);
});

test("rate limiter blocks the next request in the window", () => {
  const limiter = new RateLimiter(2, 60_000);
  assert.equal(limiter.allow("cid:a", 1_000).ok, true);
  assert.equal(limiter.allow("cid:a", 1_100).ok, true);
  const blocked = limiter.allow("cid:a", 1_200);
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.ok(blocked.retryAfterSec >= 1);
  assert.equal(limiter.allow("cid:b", 1_200).ok, true);
});

test("local driver writes atomically and keeps the previous bytes when a write fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cumulus-cloud-"));
  try {
    const store = new LocalFsBlobStore(dir);
    const key = "objects/ab/file";
    const first = await store.putStream(key, Readable.from([Buffer.from("aaaa")]));
    assert.equal(first.sha256, sha256(Buffer.from("aaaa")));
    await assert.rejects(store.putStream(key, failingStream()));
    const body = await readAll(await store.getStream(key));
    assert.equal(body.toString(), "aaaa");
    const range = await readAll(await store.getStream(key, { start: 1, end: 2 }));
    assert.equal(range.toString(), "aa");
    const again = new LocalFsBlobStore(dir);
    assert.equal((await again.verify(key)).sha256, first.sha256);
    const names = await readdir(join(dir, "objects", "ab"));
    assert.equal(names.some((name) => name.includes(".tmp")), false);
    await assert.rejects(() => store.putStream("../outside", Readable.from([Buffer.from("x")])), DriveError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chunked encryption round-trips and the master key is read by env name", async () => {
  const plain = Buffer.from("hello cloud ".repeat(200));
  const dek = randomBytes(32);
  const salt = randomBytes(4);
  const encrypted = await readAll(encryptPlaintext(Readable.from([plain]), dek, salt, 1024, 0, true));
  assert.equal(encrypted.includes(Buffer.from("hello cloud ")), false);
  const out = await readAll(decryptPlaintext(Readable.from(encrypted), dek, salt, plain.length));
  assert.equal(out.equals(plain), true);
  const secret = randomBytes(32).toString("base64");
  const master = MasterKey.fromEnv({ CUMULUS_CLOUD_KMS_KEY_NAME: "CUMULUS_CLOUD_TEST_KEY", CUMULUS_CLOUD_TEST_KEY: secret });
  assert.ok(master);
  assert.equal(master.unwrap(master.wrap(dek)).equals(dek), true);
  assert.equal(master.name, "CUMULUS_CLOUD_TEST_KEY");
});

test("S3 is rejected and is not the default", () => {
  const marker = "super-secret-value";
  assert.equal(assertLocalDriver(undefined), "local");
  assert.throws(() => assertLocalDriver("s3"), (err: unknown) => {
    assert.ok(err instanceof DriveError);
    assert.equal(err.code, "s3_disabled");
    assert.equal(err.message.includes(marker), false);
    return true;
  });
  const config = readDriveConfig({
    CUMULUS_CLOUD_DATABASE_URL: "postgres://cumulus:cumulus@127.0.0.1:5432/cloud",
    AWS_SECRET_ACCESS_KEY: marker,
  });
  assert.equal(config.driver, "local");
  assert.equal(config.host, "127.0.0.1");
  assert.throws(() => readDriveConfig({ CUMULUS_CLOUD_DRIVER: "s3", CUMULUS_CLOUD_DATABASE_URL: "postgres://local/cloud", AWS_SECRET_ACCESS_KEY: marker }), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.equal(err.message.includes(marker), false);
    return true;
  });
});

test("SQL migrations split into statements", () => {
  const statements = splitSql("-- note\nCREATE TABLE a (id INT);\n\nCREATE TABLE b (id INT);");
  assert.equal(statements.length, 2);
  assert.equal(statements[0]?.startsWith("CREATE TABLE a"), true);
});

function failingStream(): Readable {
  return Readable.from((async function* () {
    yield Buffer.from("bb");
    throw new Error("boom");
  })());
}
