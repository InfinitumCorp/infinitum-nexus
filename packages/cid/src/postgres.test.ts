/**
 * PgCidRepository against a real PostgreSQL (CID_TEST_PG_URL). The whole CID and social suites also
 * run on it (package test script, CID_TEST_PG=1); these cover what only a shared database can get
 * wrong: unique keys across servers, single-use items taken twice at once, and racing migrations.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { cidSchemaSql, migrateCid, PgCidRepository } from "./postgres.ts";
import type { Account, Session } from "./service.ts";

const url = process.env.CID_TEST_PG_URL;

describe("cidSchemaSql", () => {
  it("only takes plain schema names", () => {
    assert.match(cidSchemaSql("cumulus_id"), /CREATE SCHEMA IF NOT EXISTS "cumulus_id"/);
    for (const bad of ['x"; DROP TABLE y; --', "Upper", "1abc", ""]) assert.throws(() => cidSchemaSql(bad), /Bad schema name/);
  });
});

describe("PgCidRepository on PostgreSQL", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 8, allowExitOnIdle: true });
  const schema = `cid_pgtest_${process.pid}_${Date.now().toString(36)}`;
  after(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  const account = (cid: string, username: string, orgId?: string): Account => ({
    cid, username, mailAddress: `${username}@cumuluscloud.app`, handle: `@${username}.veil`, createdAt: "2026-11-12T00:00:00.000Z",
    entitlements: {} as Account["entitlements"], ...(orgId ? { orgId } : {}),
  });
  const session = (id: string, cid: string): Session => ({
    id, cid, tokenHash: `hash_${id}`, device: "test", method: "passkey", createdAt: "2026-11-12T00:00:00.000Z", expiresAt: "2026-12-12T00:00:00.000Z",
  });

  it("migrates safely when several servers start at once, and again later", async () => {
    await Promise.all(Array.from({ length: 6 }, () => migrateCid(pool, schema)));
    await migrateCid(pool, schema);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1", [schema]);
    assert.equal(rows[0].n, 8);
  });

  it("round-trips accounts, keeps usernames unique, and moves the username index on rename", async () => {
    const repo = new PgCidRepository({ db: pool, schema });
    await repo.putAccount(account("cid_a", "alex", "org_1"));
    await repo.putAccount(account("cid_b", "sam", "org_1"));
    assert.deepEqual(await repo.account("cid_a"), account("cid_a", "alex", "org_1"));
    assert.equal(await repo.cidForUsername("sam"), "cid_b");
    await assert.rejects(repo.putAccount(account("cid_c", "alex")), /duplicate key|unique/i, "a second server can't take the same username");
    await repo.putAccount(account("cid_a", "alexandra", "org_1"));
    assert.equal(await repo.cidForUsername("alex"), undefined);
    assert.equal(await repo.cidForUsername("alexandra"), "cid_a");
    assert.deepEqual((await repo.accountsInOrg("org_1")).map((a) => a.cid), ["cid_a", "cid_b"], "first-written order, as in memory");
  });

  it("finds sessions by token hash and lists them in the order they were created", async () => {
    const repo = new PgCidRepository({ db: pool, schema });
    for (const id of ["ses_z", "ses_a", "ses_m"]) await repo.putSession(session(id, "cid_s"));
    await repo.putSession({ ...session("ses_z", "cid_s"), revokedAt: "2026-11-13T00:00:00.000Z" });
    assert.equal((await repo.sessionByTokenHash("hash_ses_a"))?.id, "ses_a");
    assert.deepEqual((await repo.sessionsOf("cid_s")).map((s) => [s.id, Boolean(s.revokedAt)]), [["ses_z", true], ["ses_a", false], ["ses_m", false]]);
  });

  it("hands a single-use item to exactly one of many concurrent takers, and sweeps expired ones", async () => {
    const repo = new PgCidRepository({ db: pool, schema });
    await repo.putOneTime("challenge", "chal_1", { value: "v", purpose: "login", expiresAt: 2_000 });
    const takes = await Promise.all(Array.from({ length: 8 }, () => repo.takeOneTime("challenge", "chal_1")));
    assert.equal(takes.filter(Boolean).length, 1);
    assert.equal(await repo.peekOneTime("challenge", "chal_1"), undefined);

    await repo.putOneTime("challenge", "old", { value: "o", purpose: "login", expiresAt: 1_000 });
    await repo.putOneTime("challenge", "new", { value: "n", purpose: "login", expiresAt: 3_000 });
    await repo.putOneTime("mfa", "old", { cid: "cid_a", method: "passkey", device: "d", expiresAt: 1_000 });
    await repo.sweepOneTime("challenge", 2_000);
    assert.equal(await repo.peekOneTime("challenge", "old"), undefined);
    assert.equal((await repo.peekOneTime("challenge", "new"))?.value, "n");
    assert.ok(await repo.peekOneTime("mfa", "old"), "each kind is swept on its own");
  });

  it("keeps credential ids unique and grants keyed by account and app", async () => {
    const repo = new PgCidRepository({ db: pool, schema });
    const key = { id: "auth_1", cid: "cid_a", kind: "passkey" as const, label: "Laptop", credentialId: "cred_1", publicKeyCose: "pk", signCount: 0, backedUp: true, addedAt: "2026-11-12T00:00:00.000Z" };
    await repo.putAuthenticator(key);
    await assert.rejects(repo.putAuthenticator({ ...key, id: "auth_2" }), /duplicate key|unique/i);
    assert.equal((await repo.authenticatorByCredential("cred_1"))?.id, "auth_1");
    await repo.deleteAuthenticator(key);
    assert.equal(await repo.authenticatorByCredential("cred_1"), undefined);

    await repo.putGrant({ cid: "cid_a", app: "LBRNTH", scopes: ["repo:read"], grantedAt: "t", ledgerHash: "h" });
    await repo.putGrant({ cid: "cid_a", app: "LBRNTH", scopes: ["repo:read", "repo:write"], grantedAt: "t", ledgerHash: "h2" });
    assert.deepEqual((await repo.grantsOf("cid_a")).map((g) => g.scopes), [["repo:read", "repo:write"]]);
    await repo.deleteGrant("cid_a", "LBRNTH");
    assert.equal(await repo.grant("cid_a", "LBRNTH"), undefined);
  });
});
