import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import http from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { CidService, signerFromJwk } from "@infinitum/cid";
import { generateKeyPairSync } from "node:crypto";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { VirtualAuthenticator } from "../../../cid/src/testing/virtual-authenticator.ts";
import { cidAuth, issuerAuth } from "./auth.ts";
import { MasterKey } from "./crypto.ts";
import { migrate, openPool } from "./db.ts";
import { createDriveApp } from "./http.ts";
import { LocalFsBlobStore } from "./local-driver.ts";
import { DriveRepo } from "./repo.ts";
import { DriveService } from "./service.ts";

const dbUrl = process.env.CUMULUS_CLOUD_DATABASE_URL;
const required = process.env.CUMULUS_CLOUD_REQUIRE_INTEGRATION === "1";
const ORIGIN = "https://id.cumuluscloud.app";
const RP = "cumuluscloud.app";

describe("Cumulus://Cloud Drive against local PostgreSQL", {
  concurrency: 1,
  timeout: 120_000,
  skip: !dbUrl && !required ? "set CUMULUS_CLOUD_DATABASE_URL to run the PostgreSQL tests" : false,
}, () => {
  let dir = "";
  let pool: ReturnType<typeof openPool>;
  let repo: DriveRepo;
  let cid: CidService;
  let now = new Date("2026-11-07T12:00:00Z");
  let plain: { port: number; server: Server };
  let quota: { port: number; server: Server };
  let encrypted: { port: number; server: Server };
  const masterMaterial = randomBytes(32).toString("base64");

  before(async () => {
    if (!dbUrl) throw new Error("CUMULUS_CLOUD_DATABASE_URL is required");
    dir = await mkdtemp(join(tmpdir(), "cumulus-drive-"));
    pool = openPool(dbUrl);
    await migrate(pool);
    const again = await migrate(pool);
    assert.deepEqual(again, []);
    const seen = await pool.query(`SELECT 1 FROM cloud_schema_migrations WHERE id = $1`, ["001_init.sql"]);
    assert.equal(seen.rowCount, 1);
    repo = new DriveRepo(pool);
    const blobs = new LocalFsBlobStore(dir);
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    cid = new CidService({ ledger, signer, rpId: RP, origins: [ORIGIN] });
    const auth = cidAuth(cid);
    const plainService = new DriveService({
      repo,
      blobs,
      chunkSize: 1024,
      partSize: 1024,
      maxUploadBytes: 1_000_000,
      clock: () => now,
    });
    const quotaService = new DriveService({
      repo,
      blobs,
      chunkSize: 1024,
      partSize: 1024,
      maxUploadBytes: 1_000_000,
      quotaBytes: () => 50,
    });
    const encryptedService = new DriveService({
      repo,
      blobs,
      master: MasterKey.fromEnv({ CUMULUS_CLOUD_KMS_KEY_NAME: "CUMULUS_CLOUD_TEST_KEY", CUMULUS_CLOUD_TEST_KEY: masterMaterial }),
      chunkSize: 1024,
      partSize: 1024,
      maxUploadBytes: 1_000_000,
    });
    plain = await listen(createDriveApp({ service: plainService, auth, rateLimit: 500 }).server());
    quota = await listen(createDriveApp({ service: quotaService, auth, rateLimit: 500 }).server());
    encrypted = await listen(createDriveApp({ service: encryptedService, auth, rateLimit: 500 }).server());
  });

  after(async () => {
    if (plain) await close(plain.server);
    if (quota) await close(quota.server);
    if (encrypted) await close(encrypted.server);
    if (pool) await pool.end();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("requires a real Cumulus://ID session and ignores a body-supplied owner", async () => {
    const anon = await call(plain.port, "GET", "/v1/quota");
    assert.equal(anon.status, 401);
    const user = await person();
    const other = await person();
    const health = await call(plain.port, "GET", "/v1/health");
    assert.equal(health.status, 200);
    assert.equal(json(health).driver, "local");
    const created = await upload(plain.port, user.token, "owned.txt", Buffer.from("plain-hello-cloud"));
    assert.equal(created.status, 201);
    const file = json(created).file;
    assert.equal(file.sha256, sha256(Buffer.from("plain-hello-cloud")));
    assert.equal(file.encrypted, false);
    const renamed = await call(plain.port, "PATCH", `/v1/files/${file.id}`, {
      token: user.token,
      json: { name: "stolen.txt", ownerCid: other.cid },
    });
    assert.equal(renamed.status, 400);
    assert.equal(json(renamed).error.code, "owner_mismatch");
    const still = await call(plain.port, "GET", `/v1/files/${file.id}`, { token: user.token });
    assert.equal(json(still).file.name, "owned.txt");
    const outsider = await call(plain.port, "GET", `/v1/files/${file.id}`, { token: other.token });
    assert.equal(outsider.status, 404);
    const outsiderList = await call(plain.port, "GET", "/v1/list", { token: other.token });
    assert.equal(json(outsiderList).files.length, 0);
    assert.equal(await treeContains(dir, "plain-hello-cloud"), true);
  });

  it("downloads ranges, rejects an HTML content type, and verifies the checksum", async () => {
    const user = await person();
    const body = Buffer.from("abcdefghijklmnopqrstuvwxyz");
    const created = await upload(plain.port, user.token, "letters.txt", body);
    const id = json(created).file.id as string;
    const full = await call(plain.port, "GET", `/v1/files/${id}/content`, { token: user.token });
    assert.equal(full.status, 200);
    assert.equal(full.body.toString(), body.toString());
    assert.equal(full.headers["x-content-type-options"], "nosniff");
    assert.equal(sha256(full.body), json(created).file.sha256);
    const head = await call(plain.port, "GET", `/v1/files/${id}/content`, { token: user.token, headers: { range: "bytes=0-4" } });
    assert.equal(head.status, 206);
    assert.equal(head.body.toString(), "abcde");
    assert.equal(head.headers["content-range"], "bytes 0-4/26");
    const tail = await call(plain.port, "GET", `/v1/files/${id}/content`, { token: user.token, headers: { range: "bytes=-4" } });
    assert.equal(tail.status, 206);
    assert.equal(tail.body.toString(), "wxyz");
    const html = await upload(plain.port, user.token, "page.html", Buffer.from("<!DOCTYPE html><script>alert(1)</script>"), "text/html");
    const htmlId = json(html).file.id as string;
    const download = await call(plain.port, "GET", `/v1/files/${htmlId}/content`, { token: user.token });
    assert.equal(download.headers["content-type"], "application/octet-stream");
    assert.match(String(download.headers["content-disposition"]), /^attachment;/);
    const verified = await call(plain.port, "POST", `/v1/files/${id}/verify`, { token: user.token });
    assert.equal(verified.status, 200);
    assert.equal(json(verified).sha256, sha256(body));
    const mismatch = await upload(plain.port, user.token, "bad.bin", Buffer.from("nope"), "application/octet-stream", "a".repeat(64));
    assert.equal(mismatch.status, 400);
    assert.equal(json(mismatch).error.code, "checksum_mismatch");
  });

  it("moves, renames, versions, trashes, and purges without leaving the bytes or the quota", async () => {
    const user = await person();
    const folder = json(await call(plain.port, "POST", "/v1/folders", { token: user.token, json: { name: "Docs" } })).folder;
    const child = json(await call(plain.port, "POST", "/v1/folders", { token: user.token, json: { name: "Inner", parentId: folder.id } })).folder;
    const cycle = await call(plain.port, "PATCH", `/v1/folders/${folder.id}`, { token: user.token, json: { parentId: child.id } });
    assert.equal(cycle.status, 400);
    const created = await upload(plain.port, user.token, "note.txt", Buffer.from("version-one"));
    const id = json(created).file.id as string;
    const moved = await call(plain.port, "PATCH", `/v1/files/${id}`, { token: user.token, json: { folderId: folder.id, name: "note-2.txt" } });
    assert.equal(moved.status, 200);
    const root = json(await call(plain.port, "GET", "/v1/list", { token: user.token }));
    assert.equal(root.files.some((file: { id: string }) => file.id === id), false);
    const inside = json(await call(plain.port, "GET", `/v1/list?folderId=${folder.id}`, { token: user.token }));
    assert.equal(inside.files[0].name, "note-2.txt");
    const next = await upload(plain.port, user.token, "ignored.txt", Buffer.from("version-two"), "text/plain", null, `/v1/files/${id}/content`);
    assert.equal(next.status, 201);
    assert.equal(json(next).file.version, 2);
    const versions = json(await call(plain.port, "GET", `/v1/files/${id}/versions`, { token: user.token })).versions;
    assert.equal(versions.length, 2);
    const old = versions.find((version: { current: boolean }) => !version.current);
    const removed = await call(plain.port, "DELETE", `/v1/files/${id}/versions/${old.id}`, { token: user.token });
    assert.equal(removed.status, 200);
    const current = await call(plain.port, "DELETE", `/v1/files/${id}/versions/${json(next).file.versionId}`, { token: user.token });
    assert.equal(current.status, 400);
    await call(plain.port, "DELETE", `/v1/files/${id}`, { token: user.token });
    const hidden = await call(plain.port, "GET", `/v1/files/${id}/content`, { token: user.token });
    assert.equal(hidden.status, 404);
    const trash = json(await call(plain.port, "GET", "/v1/trash", { token: user.token }));
    assert.equal(trash.files.some((file: { id: string }) => file.id === id), true);
    await call(plain.port, "POST", `/v1/files/${id}/restore`, { token: user.token });
    const back = await call(plain.port, "GET", `/v1/files/${id}/content`, { token: user.token });
    assert.equal(back.body.toString(), "version-two");
    const marker = await upload(plain.port, user.token, "gone.txt", Buffer.from("purge-me-marker"));
    const markerId = json(marker).file.id as string;
    const beforeUsage = json(await call(plain.port, "GET", "/v1/quota", { token: user.token })).usedBytes as number;
    await call(plain.port, "DELETE", `/v1/files/${markerId}?purge=1`, { token: user.token });
    const afterUsage = json(await call(plain.port, "GET", "/v1/quota", { token: user.token })).usedBytes as number;
    assert.equal(afterUsage, beforeUsage - Buffer.byteLength("purge-me-marker"));
    assert.equal(await treeContains(dir, "purge-me-marker"), false);
    const restarted = new DriveService({ repo, blobs: new LocalFsBlobStore(dir), chunkSize: 1024, partSize: 1024, clock: () => now });
    const durable = await restarted.download(user.cid, id, null);
    const durableBody = await readAll(durable.stream);
    assert.equal(durableBody.toString(), "version-two");
  });

  it("resumes a multipart upload when parts arrive out of order", async () => {
    const user = await person();
    const payload = Buffer.alloc(2500, 7);
    payload.write("multipart-marker", 0);
    const started = json(await call(plain.port, "POST", "/v1/uploads", {
      token: user.token,
      json: { name: "big.bin", size: payload.length, contentType: "application/octet-stream", sha256: sha256(payload) },
    })).upload;
    const part = async (number: number, start: number, end: number) => call(plain.port, "PUT", `/v1/uploads/${started.id}/parts/${number}`, {
      token: user.token,
      body: payload.subarray(start, end),
    });
    assert.equal((await part(2, 1024, 2048)).status, 200);
    const status = json(await call(plain.port, "GET", `/v1/uploads/${started.id}`, { token: user.token })).upload;
    assert.deepEqual(status.parts.map((item: { partNumber: number }) => item.partNumber), [2]);
    assert.equal((await part(3, 2048, 2500)).status, 200);
    assert.equal((await part(1, 0, 1024)).status, 200);
    const done = await call(plain.port, "POST", `/v1/uploads/${started.id}/complete`, { token: user.token });
    assert.equal(done.status, 201, done.body.toString());
    const id = json(done).file.id as string;
    const downloaded = await call(plain.port, "GET", `/v1/files/${id}/content`, { token: user.token });
    assert.equal(downloaded.body.equals(payload), true);
    assert.equal(json(done).file.sha256, sha256(payload));
  });

  it("enforces quota and keeps one CID from spending another CID's bytes", async () => {
    const user = await person();
    const other = await person();
    const first = await upload(quota.port, user.token, "a.txt", Buffer.alloc(20, 1));
    assert.equal(first.status, 201);
    const second = await upload(quota.port, user.token, "b.txt", Buffer.alloc(40, 2));
    assert.equal(second.status, 507);
    assert.equal(json(await call(quota.port, "GET", "/v1/quota", { token: user.token })).usedBytes, 20);
    assert.equal(json(await call(quota.port, "GET", "/v1/quota", { token: other.token })).usedBytes, 0);
    const [left, right] = await Promise.all([
      upload(quota.port, user.token, "c.txt", Buffer.alloc(20, 3)),
      upload(quota.port, user.token, "d.txt", Buffer.alloc(20, 4)),
    ]);
    const statuses = [left.status, right.status].sort();
    assert.deepEqual(statuses, [201, 507]);
    assert.equal(json(await call(quota.port, "GET", "/v1/quota", { token: user.token })).usedBytes, 40);
    assert.equal(json(await call(quota.port, "GET", "/v1/quota", { token: other.token })).usedBytes, 0);
  });

  it("shares with expiry and revocation, and a revoked session or scope stops access", async () => {
    const user = await person();
    const created = await upload(plain.port, user.token, "shared.txt", Buffer.from("share-body"));
    const id = json(created).file.id as string;
    const share = json(await call(plain.port, "POST", `/v1/files/${id}/shares`, {
      token: user.token,
      json: { expiresAt: new Date(now.getTime() + 60_000).toISOString() },
    })).share;
    assert.equal(typeof share.token, "string");
    assert.equal(share.url, `https://cloud.cumuluscloud.app/v1/s/${share.token}`);
    const fromMail = await call(plain.port, "GET", "/v1/health", { headers: { origin: "https://mail.cumuluscloud.app" } });
    assert.equal(fromMail.headers["access-control-allow-origin"], "https://mail.cumuluscloud.app");
    const strangerOrigin = await call(plain.port, "GET", "/v1/health", { headers: { origin: "https://evil.example" } });
    assert.equal(strangerOrigin.headers["access-control-allow-origin"], undefined);
    const open = await call(plain.port, "GET", `/v1/s/${share.token}/content`);
    assert.equal(open.status, 200);
    assert.equal(open.body.toString(), "share-body");
    const listed = json(await call(plain.port, "GET", `/v1/files/${id}/shares`, { token: user.token })).shares;
    assert.equal(listed.some((item: { token?: string }) => "token" in item), false);
    const stranger = await person();
    assert.equal((await call(plain.port, "DELETE", `/v1/shares/${share.id}`, { token: stranger.token })).status, 404);
    now = new Date(now.getTime() + 120_000);
    assert.equal((await call(plain.port, "GET", `/v1/s/${share.token}`)).status, 404);
    now = new Date("2026-11-07T12:00:00Z");
    const fresh = json(await call(plain.port, "POST", `/v1/files/${id}/shares`, { token: user.token, json: {} })).share;
    await call(plain.port, "DELETE", `/v1/shares/${fresh.id}`, { token: user.token });
    assert.equal((await call(plain.port, "GET", `/v1/s/${fresh.token}/content`)).status, 404);
    await cid.revokeSession(user.cid, user.sessionId);
    assert.equal((await call(plain.port, "GET", `/v1/files/${id}`, { token: user.token })).status, 401);
    const writer = await person();
    await cid.revoke(writer.cid, "cumulus-cloud", ["drive:write"]);
    assert.equal((await upload(plain.port, writer.token, "nope.txt", Buffer.from("x"))).status, 403);
    assert.equal((await call(plain.port, "GET", "/v1/list", { token: writer.token })).status, 200);
    await cid.revoke(writer.cid, "cumulus-cloud");
    assert.equal((await call(plain.port, "GET", "/v1/list", { token: writer.token })).status, 403);
  });

  it("encrypts at rest with a per-file key and still supports range reads", async () => {
    const user = await person();
    const marker = `enc-marker-${randomUUID()}`;
    const payload = Buffer.from(marker + "x".repeat(1500));
    const started = json(await call(encrypted.port, "POST", "/v1/uploads", {
      token: user.token,
      json: { name: "secret.bin", size: payload.length, sha256: sha256(payload) },
    })).upload;
    assert.equal((await call(encrypted.port, "PUT", `/v1/uploads/${started.id}/parts/2`, { token: user.token, body: payload.subarray(1024) })).status, 200);
    assert.equal((await call(encrypted.port, "PUT", `/v1/uploads/${started.id}/parts/1`, { token: user.token, body: payload.subarray(0, 1024) })).status, 200);
    const done = await call(encrypted.port, "POST", `/v1/uploads/${started.id}/complete`, { token: user.token });
    assert.equal(done.status, 201, done.body.toString());
    assert.equal(json(done).file.encrypted, true);
    const id = json(done).file.id as string;
    const downloaded = await call(encrypted.port, "GET", `/v1/files/${id}/content`, { token: user.token });
    assert.equal(downloaded.body.equals(payload), true);
    const range = await call(encrypted.port, "GET", `/v1/files/${id}/content`, { token: user.token, headers: { range: "bytes=0-10" } });
    assert.equal(range.status, 206);
    assert.equal(range.body.toString(), payload.subarray(0, 11).toString());
    assert.equal(await treeContains(dir, marker), false);
    const plainRead = await call(plain.port, "GET", `/v1/files/${id}/content`, { token: user.token });
    assert.equal(plainRead.status, 500);
  });

  it("accepts Cumulus://ID access tokens instead of local sessions (issuer mode)", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const key = signerFromJwk({ ...privateKey.export({ format: "jwk" }), kid: "drive-it" });
    const ISS = "https://id.cumuluscloud.app/realms/cumulus";
    const auth = issuerAuth({ issuer: ISS, fetchImpl: (async () => Response.json({ keys: [key.publicJwk()] })) as typeof fetch });
    const app = createDriveApp({ service: new DriveService({ repo, blobs: new LocalFsBlobStore(dir), chunkSize: 1024, partSize: 1024, maxUploadBytes: 1_000_000 }), auth, rateLimit: 500 });
    const server = await listen(app.server());
    // The same claims the issuer's token endpoint signs (packages/cid product-idp.ts).
    const tokenFor = (cidValue: string, aud = "cumulus-cloud") => {
      const now = Math.floor(Date.now() / 1000);
      return key.sign({ iss: ISS, sub: cidValue, cid: cidValue, aud, azp: aud, iat: now, exp: now + 3600, sid: `ses_${randomUUID()}`, amr: ["passkey"], idp: "passkey" });
    };
    try {
      const alex = `cid_${randomUUID()}`;
      const sam = `cid_${randomUUID()}`;
      assert.equal((await call(server.port, "POST", "/v1/access", { token: tokenFor(alex) })).status, 200);
      const made = await upload(server.port, tokenFor(alex), "from-id.txt", Buffer.from("issued-by-cumulus-id"));
      assert.equal(made.status, 201, made.body.toString());
      const fileId = json(made).file.id as string;
      const mine = await call(server.port, "GET", `/v1/files/${fileId}/content`, { token: tokenFor(alex) });
      assert.equal(mine.body.toString(), "issued-by-cumulus-id");
      assert.equal((await call(server.port, "GET", `/v1/files/${fileId}`, { token: tokenFor(sam) })).status, 404, "another cid can't see it");
      assert.equal((await call(server.port, "GET", "/v1/quota", { token: tokenFor(alex, "scalvs") })).status, 401, "a token for another product is refused");
      assert.equal((await call(server.port, "GET", "/v1/quota", { token: "opaque-session-token-from-somewhere" })).status, 401);
    } finally {
      await close(server.server);
    }
  });

  it("rate limits anonymous health checks", async () => {
    const app = createDriveApp({
      service: new DriveService({ repo, blobs: new LocalFsBlobStore(dir), chunkSize: 1024, partSize: 1024 }),
      auth: cidAuth(cid),
      rateLimit: 2,
      rateWindowMs: 60_000,
    });
    const server = await listen(app.server());
    try {
      assert.equal((await call(server.port, "GET", "/v1/health")).status, 200);
      assert.equal((await call(server.port, "GET", "/v1/health")).status, 200);
      const blocked = await call(server.port, "GET", "/v1/health");
      assert.equal(blocked.status, 429);
      assert.ok(blocked.headers["retry-after"]);
    } finally {
      await close(server.server);
    }
  });

  async function person() {
    const username = `u${randomBytes(4).toString("hex")}`;
    const account = await cid.createAccount({ username });
    const authenticator = new VirtualAuthenticator();
    const options = cid.startAuthenticatorRegistration(account.cid);
    const registration = authenticator.create({ challenge: options.challenge, origin: ORIGIN, rpId: RP });
    const key = await cid.finishAuthenticatorRegistration(account.cid, registration);
    const { challenge } = cid.startSignIn();
    const signed = await cid.finishSignIn(authenticator.get({ credentialId: key.credentialId, challenge, origin: ORIGIN }), "Drive test");
    if (signed.status !== "ok") throw new Error("Cumulus://ID sign-in failed");
    const access = await call(plain.port, "POST", "/v1/access", { token: signed.token });
    assert.equal(access.status, 200);
    return { token: signed.token, cid: account.cid, sessionId: signed.session.id };
  }
});

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function upload(port: number, token: string, name: string, body: Buffer, type = "application/octet-stream", checksum: string | null = sha256(body), path = "/v1/files") {
  const headers: Record<string, string> = { "x-cumulus-name": encodeURIComponent(name), "content-type": type };
  if (checksum) headers["x-cumulus-sha256"] = checksum;
  return call(port, "POST", path, { token, body, headers });
}

function json(response: { body: Buffer }): any {
  return JSON.parse(response.body.toString() || "{}");
}

function call(port: number, method: string, path: string, opts: { token?: string; json?: unknown; body?: Buffer; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let payload: Buffer | undefined;
  if (opts.json !== undefined) {
    payload = Buffer.from(JSON.stringify(opts.json));
    headers["content-type"] = "application/json";
    headers["content-length"] = String(payload.length);
  } else if (opts.body) {
    payload = opts.body;
    if (!headers["content-length"]) headers["content-length"] = String(payload.length);
  }
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk as Buffer));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function listen(server: Server): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      resolve({ port: address.port, server });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function readAll(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function treeContains(dir: string, needle: string): Promise<boolean> {
  const target = Buffer.from(needle);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await treeContains(path, needle)) return true;
    } else if (entry.isFile() && !entry.name.endsWith(".sha256")) {
      const body = await readFile(path);
      if (body.includes(target)) return true;
    }
  }
  return false;
}
