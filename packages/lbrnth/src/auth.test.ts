import { test } from "node:test";
import assert from "node:assert/strict";
import { CidService, INFINITUM_APPS } from "@infinitum/cid";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { VirtualAuthenticator } from "../../cid/src/testing/virtual-authenticator.ts";
import { CidLabyrinth, LabyrinthError, MemoryStorage, labyrinthFromEnvironment } from "./index.ts";
import { labyrinthCommand } from "./http.ts";
import { LABYRINTH_PRODUCTS } from "@infinitum/lbrnth-client";

export async function authenticatedSetup() {
  let now = new Date("2026-11-07T03:20:00Z");
  const signer = generateSigner(); const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
  const cid = new CidService({ ledger, signer, rpId: "localhost", origins: ["http://localhost"], clock: () => now });
  const account = await cid.createAccount({ username: "labyrinth-owner" });
  const org = await cid.createOrganization("Client", account.cid);
  const authenticator = new VirtualAuthenticator();
  const registration = cid.startAuthenticatorRegistration(account.cid, "passkey");
  const credential = await cid.finishAuthenticatorRegistration(account.cid, authenticator.create({ challenge: registration.challenge, rpId: "localhost", origin: "http://localhost" }), { kind: "passkey" });
  const challenge = cid.startSignIn();
  const signIn = await cid.finishSignIn(authenticator.get({ credentialId: credential.credentialId, challenge: challenge.challenge, origin: "http://localhost" }), "test");
  assert.equal(signIn.status, "ok"); if (signIn.status !== "ok") throw new Error("Unexpected MFA");
  await cid.grant(account.cid, "LBRNTH", ["repo:read", "repo:write", "repo:admin"]);
  let paid = true;
  const auth = new CidLabyrinth(cid, { entitled: id => paid && id === org.id, storage: new MemoryStorage(), clock: () => now });
  auth.provision(signIn.token);
  return { cid, account, org, auth, token: signIn.token, session: signIn.session, setPaid: (value: boolean) => { paid = value; }, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, expire: () => { now = new Date(now.getTime() + 31 * 86400000); } };
}
const forbidden = (fn: () => unknown) => assert.throws(fn, (e: unknown) => e instanceof LabyrinthError && e.code === "forbidden");

test("CID sign-in uses real passkey sessions, never raw identities or org claims", async () => {
  const s = await authenticatedSetup();
  forbidden(() => s.auth.forSession(s.account.cid)); forbidden(() => s.auth.forSession("forged"));
  const client = s.auth.forProduct(s.token, "VEIL"); const repo = client.createRepository("code");
  const saved = client.save(repo.id, "session.json", "private", null);
  assert.equal(Buffer.from(client.load(repo.id, saved.id, "session.json")).toString(), "private");
  assert.ok(saved.tree["products/veil/session.json"]);
  assert.throws(() => labyrinthCommand(s.auth, s.token, { action: "list", product: "veil", orgId: "victim" }));
  assert.throws(() => client.save(repo.id, "../escape", "bad", saved.id));
});

test("retained authenticated handles recheck expiry, revocation, consent and plan", async () => {
  const s = await authenticatedSetup(); const client = s.auth.forSession(s.token);
  s.setPaid(false); forbidden(() => client.repositories()); s.setPaid(true);
  await s.cid.revoke(s.account.cid, "LBRNTH"); forbidden(() => client.repositories());
  await s.cid.grant(s.account.cid, "LBRNTH", ["repo:read"]);
  assert.deepEqual(client.repositories(), []);
  await s.cid.revokeSession(s.account.cid, s.session.id); forbidden(() => client.repositories());
  const other = await authenticatedSetup(); const retained = other.auth.forSession(other.token);
  other.expire(); forbidden(() => retained.repositories());
});

test("CID directory mapping prevents cross-org members and stale organization bindings", async () => {
  const s = await authenticatedSetup(); const retained = s.auth.forSession(s.token);
  const stranger = await s.cid.createAccount({ username: "other-client" });
  await s.cid.createOrganization("Other client", stranger.cid);
  forbidden(() => retained.setMember(stranger.cid, "reader"));
  const member = await s.cid.createAccount({ username: "org-member", orgId: s.org.id });
  retained.setMember(member.cid, "reader");
  assert.ok(retained.members().some(m => m.cid === member.cid && m.role === "reader"));
  s.cid.getAccount(s.account.cid).orgId = undefined;
  forbidden(() => retained.repositories());
});

test("every website registry entry requires existing CID LBRNTH scopes and paid plan", async () => {
  const s = await authenticatedSetup();
  for (const product of LABYRINTH_PRODUCTS) {
    const client = s.auth.forProduct(s.token, product.id);
    assert.ok((INFINITUM_APPS as readonly string[]).includes(client.product), "every canonical brand must be registered in CID");
    const repo = client.createRepository(`repo-${product.id}`);
    const commit = client.save(repo.id, "artifact.json", JSON.stringify({ product: product.id }), null);
    assert.equal(Buffer.from(client.load(repo.id, commit.id, "artifact.json")).toString(), JSON.stringify({ product: product.id }));
    const id = product.id === "cndctr" ? "architect" : product.id;
    assert.ok(commit.tree[`products/${id}/artifact.json`]);
  }
  s.setPaid(false);
  for (const product of LABYRINTH_PRODUCTS) forbidden(() => s.auth.forProduct(s.token, product.id).repositories());
});

test("all implemented Nexus product SDK exports invoke the authenticated RPC protocol", async () => {
  const s = await authenticatedSetup();
  for (const pkg of ["firm", "firmament", "hardware", "autonomy", "scalus", "metatron", "hrvst", "fabric", "eon", "eidetic", "data-exchange", "argus", "aether", "cloud", "mail", "conjure"]) {
    const exports = await import(`../../${pkg}/src/labyrinth.ts`);
    for (const factory of Object.values(exports) as ((options: unknown) => ReturnType<typeof import("@infinitum/lbrnth-client").createLabyrinthClient>)[]) {
      const client = factory({ endpoint: "https://cid.example/api/labyrinth", token: () => s.token, fetch: async (_url: string, init: RequestInit) => {
        assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${s.token}`);
        return Response.json(labyrinthCommand(s.auth, s.token, JSON.parse(String(init.body))));
      } });
      const repo = await client.createRepository(`${pkg}-${client.product}`);
      const version = await client.save(repo.id, "artifact.json", "client artifact", null);
      assert.equal(await client.load(repo.id, version.id, "artifact.json"), "client artifact");
    }
  }
});

test("operator configuration fails closed and derives separate per-org storage keys", () => {
  assert.equal(labyrinthFromEnvironment({}, "/unused"), undefined);
  assert.throws(() => labyrinthFromEnvironment({ LBRNTH_MASTER_KEY: "bad" }, "/unused"));
  const env = { LBRNTH_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"), LBRNTH_ENTITLED_ORGS: "org-a" };
  const config = labyrinthFromEnvironment(env, "/unused")!;
  assert.equal(config.entitled("org-a", "LBRNTH"), true);
  assert.equal(config.entitled("org-b", "LBRNTH"), false);
  env.LBRNTH_ENTITLED_ORGS = ""; assert.equal(config.entitled("org-a", "LBRNTH"), false);
});

test("browser CID login exchanges for a repository-only token linked to parent revocation", async () => {
  const s = await authenticatedSetup();
  const issued = s.auth.issueToken(s.token);
  assert.match(issued.token, /^lbrnth_/);
  assert.equal(s.cid.authenticate(issued.token), null, "repository token cannot log in to other CID apps");
  const remote = s.auth.forProduct(issued.token, "odin");
  const repo = remote.createRepository("odin-client-artifacts");
  const commit = remote.save(repo.id, "selected.json", "selected by client", null);
  assert.equal(Buffer.from(remote.load(repo.id, commit.id, "selected.json")).toString(), "selected by client");
  forbidden(() => s.auth.issueToken(issued.token));
  await s.cid.revokeSession(s.account.cid, s.session.id);
  forbidden(() => remote.repositories());
});


test("repository-only credentials expire independently and cannot forge an org or escalate revoked consent", async () => {
  const s = await authenticatedSetup(); const issued = s.auth.issueToken(s.token);
  forbidden(() => s.auth.forSession(issued.token + "tampered"));
  const remote = s.auth.forSession(issued.token);
  await s.cid.revoke(s.account.cid, "LBRNTH", ["repo:write"]);
  forbidden(() => remote.createRepository("denied"));
  assert.deepEqual(remote.repositories(), []);
  s.advance(16 * 60000); forbidden(() => remote.repositories());
  assert.ok(s.cid.authenticate(s.token), "the parent CID session is still active");
});

test("explicit CID consent cannot purchase entitlement, add org roles or be changed by repository-only tokens", async () => {
  const s = await authenticatedSetup(); const issued = s.auth.issueToken(s.token);
  await assert.rejects(s.auth.consent(issued.token, ["repo:admin"]), /Direct Cumulus ID/);
  await s.cid.revoke(s.account.cid, "LBRNTH");
  s.setPaid(false); await s.auth.consent(s.token, ["repo:read"]);
  assert.equal(s.cid.can(s.account.cid, "LBRNTH", "repo:read"), true);
  forbidden(() => s.auth.forSession(s.token).repositories());
  await assert.rejects(s.auth.consent(s.token, ["unknown:scope"] as never));
});


test("CID directory admin demotion revokes repository administration on retained handles", async () => {
  const s = await authenticatedSetup(); const retained = s.auth.forSession(s.token);
  const member = await s.cid.createAccount({ username: "reader-client", orgId: s.org.id });
  forbidden(() => retained.setMember(member.cid, "admin"));
  retained.setMember(member.cid, "reader");
  s.cid.store.orgs.get(s.org.id)!.admins = [];
  forbidden(() => retained.setMember(member.cid, "writer")); forbidden(() => retained.audit());
});


test("repeated existing consent does not append duplicate Firmament grants", async () => {
  const s = await authenticatedSetup();
  const before = (await s.cid.permissionHistory(s.account.cid)).length;
  await s.auth.consent(s.token, ["repo:read"]); await s.auth.consent(s.token, ["repo:read"]);
  assert.equal((await s.cid.permissionHistory(s.account.cid)).length, before);
});
