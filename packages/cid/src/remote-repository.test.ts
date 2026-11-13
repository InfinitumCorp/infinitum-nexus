/**
 * RemoteCidRepository (ID rows behind nexus-store): a request sees its own writes before they are
 * committed, and two servers can't both win a race for the same row. The full CID suites also run
 * on it (CID_TEST_REMOTE_REPO=1, committing after every write).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RemoteCidRepository } from "./remote-repository.ts";
import { RowConflict, TestCidServer } from "./testing/remote-server.ts";
import type { Account, Session } from "./service.ts";

const account = (cid: string, username: string, orgId?: string): Account => ({
  cid, username, mailAddress: `${username}@cumuluscloud.app`, handle: `@${username}.veil`, createdAt: "2026-11-13T00:00:00.000Z",
  entitlements: {} as Account["entitlements"], ...(orgId ? { orgId } : {}),
});
const session = (id: string, cid: string): Session => ({
  id, cid, tokenHash: `hash_${id}`, device: "d", method: "passkey", createdAt: "2026-11-13T00:00:00.000Z", expiresAt: "2026-12-13T00:00:00.000Z",
});

/** A server and a "request" against it: the repository plus a commit like RemoteState's. */
function setup() {
  const server = new TestCidServer();
  const instance = () => {
    const repo = new RemoteCidRepository((ops) => server.read(ops));
    const commit = async () => {
      await server.apply(repo.pending());
      repo.begin();
    };
    return { repo, commit };
  };
  return { server, instance };
}

describe("RemoteCidRepository", () => {
  it("a request sees its own writes before commit; the server sees them only after", async () => {
    const { server, instance } = setup();
    const { repo, commit } = instance();
    await repo.putAccount(account("cid_a", "alex", "org_1"));
    await repo.putSession(session("ses_1", "cid_a"));
    assert.equal(await repo.cidForUsername("alex"), "cid_a");
    assert.deepEqual((await repo.allAccounts()).map((a) => a.cid), ["cid_a"]);
    assert.deepEqual((await repo.accountsInOrg("org_1")).map((a) => a.cid), ["cid_a"]);
    assert.equal((await repo.sessionByTokenHash("hash_ses_1"))?.id, "ses_1");
    assert.equal(await server.repo.account("cid_a"), undefined, "nothing on the server yet");
    await commit();
    assert.equal((await server.repo.account("cid_a"))?.username, "alex");
    assert.equal((await repo.account("cid_a"))?.username, "alex", "a new request reads it back from the server");
  });

  it("merges server lists with the request's changes: replaced, revoked, renamed and new", async () => {
    const { instance } = setup();
    const first = instance();
    await first.repo.putAccount(account("cid_a", "alex"));
    await first.repo.putAccount(account("cid_b", "sam"));
    for (const id of ["s1", "s2", "s3"]) await first.repo.putSession(session(id, "cid_a"));
    await first.commit();

    const { repo } = instance();
    const [s1] = await repo.sessionsOf("cid_a");
    await repo.putSession({ ...s1!, revokedAt: "2026-11-13T01:00:00.000Z" });
    await repo.putSession(session("s4", "cid_a"));
    assert.deepEqual((await repo.sessionsOf("cid_a")).map((s) => [s.id, Boolean(s.revokedAt)]), [["s1", true], ["s2", false], ["s3", false], ["s4", false]]);

    await repo.putAccount({ ...(await repo.account("cid_a"))!, username: "alexandra" });
    assert.equal(await repo.cidForUsername("alex"), undefined, "the old username is gone for this request");
    assert.equal(await repo.cidForUsername("alexandra"), "cid_a");
    assert.deepEqual((await repo.allAccounts()).map((a) => a.username), ["alexandra", "sam"]);
  });

  it("of two servers taking the same single-use code, exactly one commits", async () => {
    const { instance } = setup();
    const setupReq = instance();
    await setupReq.repo.putOneTime("challenge", "c1", { value: "v", purpose: "login", expiresAt: 9e15 });
    await setupReq.commit();

    const a = instance();
    const b = instance();
    assert.ok(await a.repo.takeOneTime("challenge", "c1"));
    assert.ok(await b.repo.takeOneTime("challenge", "c1"), "both read it before either commits");
    await a.commit();
    await assert.rejects(b.commit(), RowConflict, "the second server's commit is refused, so its request re-runs");
    b.repo.begin();
    assert.equal(await b.repo.takeOneTime("challenge", "c1"), undefined, "and on the re-run the code is gone");
  });

  it("refuses a write based on a row another server changed meanwhile, and applies nothing from that request", async () => {
    const { server, instance } = setup();
    const s = instance();
    await s.repo.putAccount(account("cid_a", "alex"));
    await s.commit();

    const a = instance();
    const b = instance();
    const fromA = (await a.repo.account("cid_a"))!;
    const fromB = (await b.repo.account("cid_a"))!;
    await a.repo.putAccount({ ...fromA, handle: "@a.veil" });
    await a.commit();
    await b.repo.putSession(session("s_b", "cid_a"));
    await b.repo.putAccount({ ...fromB, handle: "@b.veil" });
    await assert.rejects(b.commit(), RowConflict);
    assert.equal((await server.repo.account("cid_a"))?.handle, "@a.veil");
    assert.equal(await server.repo.session("s_b"), undefined, "all or nothing");
  });

  it("refuses the second of two servers claiming the same username", async () => {
    const { instance } = setup();
    const a = instance();
    const b = instance();
    assert.equal(await a.repo.cidForUsername("kim"), undefined);
    assert.equal(await b.repo.cidForUsername("kim"), undefined);
    await a.repo.putAccount(account("cid_1", "kim"));
    await b.repo.putAccount(account("cid_2", "kim"));
    await a.commit();
    await assert.rejects(b.commit(), RowConflict);
  });

  it("begin() drops everything a discarded attempt did", async () => {
    const { server, instance } = setup();
    const { repo } = instance();
    await repo.putAccount(account("cid_x", "temp"));
    repo.begin();
    assert.deepEqual(repo.pending(), []);
    assert.equal(await repo.cidForUsername("temp"), undefined);
    assert.equal(server.commits, 0);
  });
});
