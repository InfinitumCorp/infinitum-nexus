/**
 * The phase-3 backfill: a real CidService builds the document (accounts, passkeys, sessions, grants,
 * an org, a social link), it goes through the same JSON round trip as nexus_docs, and is copied
 * into a repository and verified. Runs on a copying in-memory repository always, and on PostgreSQL
 * when CID_TEST_PG_URL is set.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { backfillCid, checkCidStore, cidStoreFromRepository, cidStoreFromSnapshot } from "./backfill.ts";
import { exportCidAccounts } from "./account-export.ts";
import { CidService, CidStore } from "./service.ts";
import { CopyingCidRepository } from "./testing/copying-repository.ts";
import { PgCidRepository, migrateCid } from "./postgres.ts";
import type { CidRepository } from "./repository.ts";

/** The document as nexus_docs holds it: Maps as { __map: [...] }, through JSON. */
function snapshotOf(store: CidStore): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(store)) out[k] = v instanceof Map ? { __map: [...v.entries()] } : v;
  return JSON.parse(JSON.stringify(out));
}

async function populated() {
  const signer = generateSigner();
  const store = new CidStore();
  const cid = new CidService({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "id.example", origins: ["https://id.example"], store });
  const alex = await cid.createAccount({ username: "alex" });
  const sam = await cid.createAccount({ username: "sam" });
  await (cid as any).issueSession(alex.cid, "browser", "passkey");
  await (cid as any).issueSession(alex.cid, "phone", "passkey");
  await (cid as any).issueSession(sam.cid, "laptop", "passkey");
  await cid.grant(alex.cid, "LBRNTH", ["repo:read"]);
  store.authenticators.set("auth_1", { id: "auth_1", cid: alex.cid, kind: "passkey", label: "Laptop", credentialId: "cred_1", publicKeyCose: "pk", signCount: 3, backedUp: true, addedAt: "2026-11-12T00:00:00.000Z" });
  store.byCredentialId.set("cred_1", "auth_1");
  store.orgs.set("org_1", { id: "org_1", name: "Infinitum", admins: [sam.cid] });
  store.accounts.get(sam.cid)!.orgId = "org_1";
  store.byIdentity.set(`google|123`, alex.cid);
  store.accounts.get(alex.cid)!.identities = [{ provider: "google", subject: "123", linkedAt: "2026-11-12T00:00:00.000Z" }];
  store.challenges.set("c1", { value: "v", purpose: "login", expiresAt: Date.now() + 60_000 });
  return { store, alex, sam };
}

async function roundTrip(target: CidRepository) {
  const { store, alex } = await populated();
  const source = cidStoreFromSnapshot(snapshotOf(store));
  assert.equal(source.accounts.size, 2);
  const report = await backfillCid(source, target);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.sourceHash, report.targetHash);
  assert.deepEqual(report.counts, { accounts: 2, identities: 1, federation: 0, authenticators: 1, sessions: 3, grants: 1, orgs: 1 });
  assert.equal(report.skippedOneTime, 1, "single-use items are left behind");
  assert.equal(report.written, 9);
  // Running it again is safe and still exact.
  const again = await backfillCid(source, target);
  assert.deepEqual(again.mismatches, []);
  // And a CidService on the target sees the same people.
  const signer = generateSigner();
  const svc = new CidService({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "id.example", origins: ["https://id.example"], repository: target });
  assert.equal((await svc.getAccount(alex.cid)).username, "alex");
  assert.equal((await svc.listSessions(alex.cid)).length, 2);
  assert.equal(await svc.can(alex.cid, "LBRNTH", "repo:read"), true);
  // The migration export reads through the repository too, so it sees the copied accounts.
  const exported = await exportCidAccounts(svc);
  assert.deepEqual(exported.counts, { accounts: 2, authenticators: 1, identities: 1, grants: 1 });

  // The reverse copy (rollback to the document) gives back the same entities and lookups.
  const back = await cidStoreFromRepository(target);
  const entities = (st: CidStore) => {
    const out: Record<string, unknown> = {};
    for (const k of ["accounts", "byUsername", "byFederation", "byIdentity", "authenticators", "byCredentialId", "sessions", "byTokenHash", "grants", "orgs"] as const) {
      out[k] = [...(st[k] as Map<string, unknown>).entries()].sort(([a], [b]) => a.localeCompare(b));
    }
    return JSON.parse(JSON.stringify(out));
  };
  assert.deepEqual(entities(back), entities(source));
  assert.equal(back.challenges.size, 0, "single-use items aren't carried back");
}

describe("Cumulus://ID backfill", () => {
  it("copies the document into a repository and verifies every entity and lookup", async () => {
    await roundTrip(new CopyingCidRepository());
  });

  it("refuses to write a document the database would reject, and says why", async () => {
    const { store, alex, sam } = await populated();
    store.authenticators.set("auth_2", { ...store.authenticators.get("auth_1")!, id: "auth_2", cid: sam.cid });
    store.sessions.set("ses_ghost", { id: "ses_ghost", cid: "cid_missing", tokenHash: "h", device: "d", method: "passkey", createdAt: "t", expiresAt: "t" });
    const check = checkCidStore(store);
    assert.ok(check.problems.some((p) => /credential id cred_1 is used by both auth_1 and auth_2/.test(p)), check.problems.join("\n"));
    assert.ok(check.problems.some((p) => /session ses_ghost belongs to missing account/.test(p)));
    await assert.rejects(backfillCid(store, new CopyingCidRepository()), /Not writing: 2 problem/);
    assert.ok(alex);
  });

  it("reports an entity that reads back differently", async () => {
    const { store } = await populated();
    class Lossy extends CopyingCidRepository {
      override async account(cid: string) {
        const a = await super.account(cid);
        return a && { ...a, handle: "@tampered" };
      }
    }
    const lossy = new Lossy();
    const report = await backfillCid(store, lossy);
    assert.equal(report.mismatches.length, 2);
    assert.notEqual(report.sourceHash, report.targetHash);
  });

  const url = process.env.CID_TEST_PG_URL;
  it("copies into PostgreSQL", { skip: url ? false : "set CID_TEST_PG_URL to run" }, async () => {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 4, allowExitOnIdle: true });
    const schema = `cid_backfill_test_${process.pid}`;
    after(async () => {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    });
    await migrateCid(pool, schema);
    await roundTrip(new PgCidRepository({ db: pool, schema }));
  });
});
