import { createHash, randomUUID } from "node:crypto";
import { lutimes, mkdir, mkdtemp, rm, symlink, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { migrate, openPool } from "./db.ts";
import { LocalFsBlobStore } from "./local-driver.ts";
import { DriveRepo } from "./repo.ts";
import { DriveService } from "./service.ts";
import { DriveError } from "./errors.ts";

const dbUrl = process.env.CUMULUS_CLOUD_DATABASE_URL;
const required = process.env.CUMULUS_CLOUD_REQUIRE_INTEGRATION === "1";
const HOUR = 3_600_000;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Every path under dir, relative, sorted. */
async function tree(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await tree(full, base)));
    else out.push(full.slice(base.length + 1));
  }
  return out.sort();
}

async function age(path: string, hours: number, now: Date) {
  const t = new Date(now.getTime() - hours * HOUR);
  await lutimes(path, t, t); // never follows a symlink
}

describe("Cumulus://Cloud orphan sweep against local PostgreSQL", {
  concurrency: 1,
  timeout: 120_000,
  skip: !dbUrl && !required ? "set CUMULUS_CLOUD_DATABASE_URL to run the PostgreSQL tests" : false,
}, () => {
  let dir = "";
  let pool: ReturnType<typeof openPool>;
  let service: DriveService;
  let blobs: LocalFsBlobStore;
  const now = new Date();

  before(async () => {
    if (!dbUrl) throw new Error("CUMULUS_CLOUD_DATABASE_URL is required");
    dir = await mkdtemp(join(tmpdir(), "cumulus-sweep-"));
    pool = openPool(dbUrl);
    await migrate(pool);
    blobs = new LocalFsBlobStore(dir);
    service = new DriveService({ repo: new DriveRepo(pool), blobs, chunkSize: 1024, partSize: 1024, maxUploadBytes: 1_000_000, clock: () => now });
  });

  after(async () => {
    if (pool) await pool.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("removes only old bytes nothing points at, and leaves live files, open uploads and foreign files alone", async () => {
    const owner = `cid_${randomUUID()}`;
    const body = Buffer.from("live-file-bytes");
    const live = await service.upload(owner, Readable.from([body]), { name: "live.txt", folderId: null, declaredSize: body.length, declaredType: "text/plain", expectedSha256: sha(body) });

    // An open multipart upload with one part saved: referenced by cloud_upload_parts.
    const part = Buffer.alloc(1024, 7);
    const up = await service.startUpload(owner, { name: "big.bin", folderId: null, fileId: null, declaredSize: 2048, declaredType: "application/octet-stream", expectedSha256: null });
    await service.putPart(owner, up.id, 1, Readable.from([part]), part.length);

    // A crash between the blob write and the database commit: bytes with no row.
    await blobs.putStream("objects/ab/" + randomUUID(), Readable.from([Buffer.from("orphan")]));
    // The same, but written a minute ago: may still be an upload in flight.
    const youngKey = "objects/ab/" + randomUUID();
    await blobs.putStream(youngKey, Readable.from([Buffer.from("in-flight")]));
    // A half-written temporary file from an interrupted putStream.
    await mkdir(join(dir, "objects/cd"), { recursive: true });
    const temp = join(dir, "objects/cd", `.${randomUUID()}.tmp`);
    await writeFile(temp, "partial");
    // Files this driver never wrote: an operator's note and a symlink. Never touched.
    await writeFile(join(dir, "README.ops"), "do not delete");
    const outside = await mkdtemp(join(tmpdir(), "cumulus-sweep-outside-"));
    await writeFile(join(outside, "target"), "outside the store");
    await symlink(join(outside, "target"), join(dir, "objects/ab/linked"));

    // Everything is old except the in-flight object.
    for (const p of await tree(dir)) await age(join(dir, p), p.startsWith(youngKey) ? 0 : 48, now);

    const before = await tree(dir);
    const report = await service.sweepOrphanBlobs();
    assert.equal(report.dryRun, true);
    assert.equal(report.orphans.length, 1);
    assert.match(report.orphans[0]!, /^objects\/ab\//);
    assert.equal(report.temps.length, 1);
    assert.equal(report.deleted, 0);
    assert.deepEqual(await tree(dir), before, "a dry run changes nothing");

    const swept = await service.sweepOrphanBlobs({ dryRun: false, batchSize: 1 });
    assert.deepEqual(swept.orphans, report.orphans);
    assert.equal(swept.deleted, 2);
    const after = await tree(dir);
    assert.ok(!after.includes(report.orphans[0]!) && !after.includes(`${report.orphans[0]}.sha256`), "orphan and its checksum sidecar are gone");
    assert.ok(!after.some((p) => p.endsWith(".tmp")), "temp file is gone");
    assert.ok(after.includes(youngKey), "a young object is kept");
    assert.ok(after.includes("README.ops") && after.includes("objects/ab/linked"), "foreign files are kept");

    // The live file and the open upload still work.
    assert.deepEqual(await service.verifyFile(owner, live.id), { sha256: sha(body), size: body.length });
    const status = await service.uploadStatus(owner, up.id);
    assert.equal(status.parts.length, 1);

    // Nothing left to do.
    const again = await service.sweepOrphanBlobs({ dryRun: false });
    assert.equal(again.orphans.length + again.temps.length, 0);
    await rm(outside, { recursive: true, force: true });
  });

  it("refuses a grace period under an hour", async () => {
    await assert.rejects(service.sweepOrphanBlobs({ graceMs: 60_000 }), (e: DriveError) => e.code === "grace_too_short");
  });
});
