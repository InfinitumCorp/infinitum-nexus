import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { CidService, labyrinthDirectoryKeyMatches } from "@infinitum/cid";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { VirtualAuthenticator } from "../../cid/src/testing/virtual-authenticator.ts";
import { LabyrinthHost, LabyrinthStorageConflict, LocalCidDirectory, PostgresStorage, RemoteCidDirectory } from "./index.ts";
import type { Organization, SqlDatabase } from "./index.ts";

const MIGRATION = readFileSync(new URL("../../../supabase/migrations/20261111_lbrnth_store.sql", import.meta.url), "utf8");
const clock = () => new Date("2026-11-11T12:00:00Z");

async function database(): Promise<{ pg: PGlite; db: SqlDatabase }> {
  const pg = new PGlite();
  await pg.exec("create role anon; create role authenticated;");
  await pg.exec(MIGRATION);
  const db: SqlDatabase = {
    query: (text, params) => pg.query(text, params) as never,
    transaction: fn => pg.transaction(tx => fn({ query: (text, params) => tx.query(text, params) as never })),
  };
  return { pg, db };
}

const key = (fill: number) => () => new Uint8Array(32).fill(fill);
const org = (id: string, name = "Client"): Organization => ({ id, name, members: [{ cid: "cid_a", role: "owner" }], repositories: [], audit: [] });

test("migration enables RLS, gives anon/authenticated nothing and creates the three tables", async () => {
  const { pg } = await database();
  const tables = (await pg.query<{ tablename: string; rowsecurity: boolean }>("select tablename, rowsecurity from pg_tables where schemaname = 'lbrnth' order by tablename")).rows;
  assert.deepEqual(tables.map(t => t.tablename), ["delegations", "entitlements", "org_snapshots"]);
  assert.ok(tables.every(t => t.rowsecurity));
  const grants = (await pg.query("select grantee from information_schema.role_table_grants where table_schema = 'lbrnth' and grantee in ('anon', 'authenticated')")).rows;
  assert.equal(grants.length, 0);
});

test("envelopes round-trip across instances, stay encrypted and only move forward by compare-and-swap", async () => {
  const { pg, db } = await database();
  const a = new PostgresStorage(db, key(1));
  await a.refresh();
  assert.deepEqual(a.load(), []);
  a.save([org("org_1", "Secret Client Name")]);
  assert.equal(a.dirty, true);
  await a.flush();

  const raw = (await pg.query<{ ciphertext: Uint8Array; revision: number }>("select ciphertext, revision from lbrnth.org_snapshots")).rows[0];
  assert.equal(Number(raw.revision), 1);
  assert.ok(!Buffer.from(raw.ciphertext).toString("latin1").includes("Secret Client Name"));

  const b = new PostgresStorage(db, key(1));
  await b.refresh();
  assert.equal(b.load()[0].name, "Secret Client Name");

  // Two writers loaded revision 1. The first wins; the second writes nothing.
  a.save([{ ...org("org_1"), name: "A" }]);
  b.save([{ ...org("org_1"), name: "B" }]);
  await a.flush();
  await assert.rejects(b.flush(), LabyrinthStorageConflict);
  assert.equal(Number((await pg.query<{ revision: number }>("select revision from lbrnth.org_snapshots")).rows[0].revision), 2);
  assert.equal(await b.refresh(), true);
  assert.equal(b.load()[0].name, "A");

  // Unchanged organizations are not rewritten.
  b.save(b.load());
  await b.flush();
  assert.equal(Number((await pg.query<{ revision: number }>("select revision from lbrnth.org_snapshots")).rows[0].revision), 2);
});

test("a wrong key, a replayed old envelope and deletions all fail closed", async () => {
  const { pg, db } = await database();
  const a = new PostgresStorage(db, key(1));
  await a.refresh();
  a.save([org("org_1", "v1")]);
  await a.flush();
  const v1 = (await pg.query<{ nonce: Uint8Array; tag: Uint8Array; ciphertext: Uint8Array }>("select nonce, tag, ciphertext from lbrnth.org_snapshots")).rows[0];
  a.save([org("org_1", "v2")]);
  await a.flush();

  await assert.rejects(new PostgresStorage(db, key(2)).refresh(), /wrong key or tampered/);
  await assert.rejects(pg.query("delete from lbrnth.org_snapshots"), /cannot be deleted/);
  await assert.rejects(pg.query("update lbrnth.org_snapshots set revision = revision"), /exactly one/);
  await assert.rejects(pg.query("update lbrnth.org_snapshots set revision = 1"), /exactly one/);

  // Someone with database access copies the revision-1 envelope forward as revision 3.
  await pg.query("update lbrnth.org_snapshots set revision = 3, nonce = $1, tag = $2, ciphertext = $3", [v1.nonce, v1.tag, v1.ciphertext]);
  await assert.rejects(new PostgresStorage(db, key(1)).refresh(), /wrong key or tampered/);
});

test("save refuses to drop an organization and load requires refresh", async () => {
  const { db } = await database();
  const s = new PostgresStorage(db, key(1));
  assert.throws(() => s.load(), /refresh/);
  await s.refresh();
  s.save([org("org_1")]);
  await s.flush();
  assert.throws(() => s.save([]), /never removes/);
});

test("directory key comparison is exact and rejects short or unset keys", () => {
  const presented = "k".repeat(40);
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  assert.equal(labyrinthDirectoryKeyMatches(presented, hash(presented)), true);
  assert.equal(labyrinthDirectoryKeyMatches("k".repeat(41), hash(presented)), false);
  assert.equal(labyrinthDirectoryKeyMatches("short", hash("short")), false);
  assert.equal(labyrinthDirectoryKeyMatches(presented, undefined), false);
  assert.throws(() => new RemoteCidDirectory("http://id.example.com/api/id/labyrinth-directory", presented), /HTTPS/);
});

async function signedIn(cid: CidService, username: string) {
  const account = await cid.createAccount({ username });
  const authenticator = new VirtualAuthenticator();
  const registration = await cid.startAuthenticatorRegistration(account.cid, "passkey");
  const credential = await cid.finishAuthenticatorRegistration(account.cid, authenticator.create({ challenge: registration.challenge, rpId: "localhost", origin: "http://localhost" }), { kind: "passkey" });
  const challenge = await cid.startSignIn();
  const signIn = await cid.finishSignIn(authenticator.get({ credentialId: credential.credentialId, challenge: challenge.challenge, origin: "http://localhost" }), "test");
  if (signIn.status !== "ok") throw new Error("Unexpected MFA");
  return { account, token: signIn.token, sessionId: (await cid.authenticate(signIn.token))!.session.id };
}

test("hosted Labyrinth: live CID onboarding, paid-plan gate, repository bearers across instances, revocation", async () => {
  const { pg, db } = await database();
  const signer = generateSigner();
  const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
  const cid = new CidService({ ledger, signer, rpId: "localhost", origins: ["http://localhost"], clock });
  const directory = new LocalCidDirectory(cid);
  const host = (allow: string[] = []) => new LabyrinthHost({ db, masterKey: new Uint8Array(32).fill(7), directory, clock, entitledOrgs: () => allow });
  const one = host();
  const two = host();
  const owner = await signedIn(cid, "lab-owner");
  const call = (h: LabyrinthHost, token: string, body: Record<string, unknown>) => h.run(token, { product: "architect", ...body });

  assert.equal((await call(one, "x".repeat(40), { action: "session" })).status, 401);
  const before = await call(one, owner.token, { action: "session" });
  assert.equal(before.status, 200);
  assert.deepEqual(before.body, { cid: owner.account.cid, organization: null, delegated: false, scopes: [] });

  // Onboarding: first organization and explicit consent, both recorded by Cumulus ID itself.
  const created = await call(one, owner.token, { action: "organization", name: "Architect client" });
  assert.equal(created.status, 200);
  const orgId = (created.body as { id: string }).id;
  assert.equal((await cid.organizationMembership(owner.account.cid))?.id, orgId);
  assert.equal((await call(one, owner.token, { action: "consent", scopes: ["repo:read", "repo:write", "repo:admin"] })).status, 200);
  assert.equal(await cid.can(owner.account.cid, "LBRNTH", "repo:write"), true);

  // Consent is not a plan: without an entitlement every repository call is refused.
  assert.equal((await call(one, owner.token, { action: "provision" })).status, 403);
  await pg.query("insert into lbrnth.entitlements (org_id, plan, source) values ($1, 'client', 'operator')", [orgId]);
  assert.equal((await call(one, owner.token, { action: "provision" })).status, 200);

  // Architect's flow with a 15-minute repository-only bearer.
  const issued = await call(one, owner.token, { action: "token" });
  assert.equal(issued.status, 200);
  const bearer = (issued.body as { token: string }).token;
  assert.match(bearer, /^lbrnth_/);
  const stored = (await pg.query<{ token_hash: string }>("select token_hash from lbrnth.delegations")).rows;
  assert.equal(stored.length, 1);
  assert.notEqual(stored[0].token_hash, bearer);

  const repo = await call(two, bearer, { action: "create", name: "architect" }); // another instance
  assert.equal(repo.status, 200);
  const repoId = (repo.body as { id: string }).id;
  const saved = await call(one, bearer, { action: "save", repo: repoId, path: "runs/r1.json", content: "{\"ok\":true}", expectedHead: null, message: "Architect run" });
  assert.equal(saved.status, 200);
  const head = (saved.body as { id: string }).id;
  assert.equal((await call(two, bearer, { action: "save", repo: repoId, path: "runs/r2.json", content: "{}", expectedHead: null })).status, 409);
  const loaded = await call(two, bearer, { action: "load", repo: repoId, commit: head, path: "runs/r1.json" });
  assert.deepEqual(loaded, { status: 200, body: { content: "{\"ok\":true}" } });
  const history = await call(one, bearer, { action: "history", repo: repoId, branch: "main", limit: 200 });
  assert.equal((history.body as unknown[]).length, 1);

  // A bearer cannot mint bearers, give consent or create organizations.
  assert.equal((await call(one, bearer, { action: "token" })).status, 403);
  assert.equal((await call(one, bearer, { action: "consent", scopes: ["repo:read"] })).status, 403);

  // A restarted host reads everything back from Postgres.
  const restarted = host();
  assert.equal(((await call(restarted, bearer, { action: "list" })).body as { name: string }[])[0].name, "architect");

  // Revoking the plan or the parent Cumulus ID session cuts access immediately.
  await pg.query("update lbrnth.entitlements set active = false where org_id = $1", [orgId]);
  assert.equal((await call(one, bearer, { action: "list" })).status, 403);
  await pg.query("update lbrnth.entitlements set active = true where org_id = $1", [orgId]);
  assert.equal((await call(one, bearer, { action: "list" })).status, 200);
  await cid.revokeSession(owner.account.cid, owner.sessionId);
  assert.equal((await call(one, bearer, { action: "list" })).status, 401);
  assert.equal((await call(two, owner.token, { action: "list" })).status, 401);
});

test("hosted Labyrinth: a second instance picks up the first one's commit before writing, and the allowlist also entitles", async () => {
  const { db } = await database();
  const signer = generateSigner();
  const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
  const cid = new CidService({ ledger, signer, rpId: "localhost", origins: ["http://localhost"], clock });
  const directory = new LocalCidDirectory(cid);
  const owner = await signedIn(cid, "lab-race");
  const org = await cid.createOrganization("Race client", owner.account.cid);
  await cid.grant(owner.account.cid, "LBRNTH", ["repo:read", "repo:write", "repo:admin"]);
  const make = () => new LabyrinthHost({ db, masterKey: new Uint8Array(32).fill(9), directory, clock, entitledOrgs: () => [org.id] });
  const a = make();
  const b = make();
  const call = (h: LabyrinthHost, body: Record<string, unknown>) => h.run(owner.token, { product: "architect", ...body });
  assert.equal((await call(a, { action: "provision" })).status, 200);
  const repoId = ((await call(a, { action: "create", name: "shared" })).body as { id: string }).id;
  assert.equal((await call(b, { action: "list" })).status, 200); // b now caches the current state

  // a commits; b's cached state is older, so b reloads before it runs the next command.
  const first = await call(a, { action: "save", repo: repoId, path: "a.txt", content: "a", expectedHead: null });
  assert.equal(first.status, 200);
  const head = (first.body as { id: string }).id;
  const second = await call(b, { action: "save", repo: repoId, path: "b.txt", content: "b", expectedHead: head });
  assert.equal(second.status, 200);
  const files = (await call(a, { action: "history", repo: repoId })).body as { tree: Record<string, string> }[];
  assert.deepEqual(Object.keys(files[0].tree).sort(), ["products/architect/a.txt", "products/architect/b.txt"]);
});

test("directory key check accepts one of several hashes (Russia and US hosts)", () => {
  const hash = (v: string) => createHash("sha256").update(v).digest("hex");
  const ru = "r".repeat(40), us = "u".repeat(40);
  assert.equal(labyrinthDirectoryKeyMatches(us, `${hash(ru)},${hash(us)}`), true);
  assert.equal(labyrinthDirectoryKeyMatches(ru, `${hash(ru)}, ${hash(us)}`), true);
  assert.equal(labyrinthDirectoryKeyMatches("x".repeat(40), `${hash(ru)},${hash(us)}`), false);
  assert.equal(labyrinthDirectoryKeyMatches(us, `${hash(ru)},not-a-hash`), false);
  assert.equal(labyrinthDirectoryKeyMatches(us, ","), false);
});
