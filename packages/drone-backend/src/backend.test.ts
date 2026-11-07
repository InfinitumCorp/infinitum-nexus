import { test } from "node:test";
import assert from "node:assert/strict";
import { CidService } from "@infinitum/cid";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { VirtualAuthenticator } from "../../cid/src/testing/virtual-authenticator.ts";
import { CidLabyrinth, MemoryStorage } from "@infinitum/lbrnth";
import { droneBackend } from "./backend.ts";
import { frame } from "./fixtures.ts";

async function setup() {
  const signer = generateSigner(); const ledger = new Ledger(undefined, {authorizedSigners: [signer.publicKey]});
  let now = new Date("2026-11-07T04:00:00Z");
  const cid = new CidService({ ledger, signer, rpId: "localhost", origins: ["http://localhost"], clock: () => now });
  let paid = true;
  const auth = new CidLabyrinth(cid, {storage: new MemoryStorage(), entitled: () => paid, clock: () => now});
  let count = 0;
  async function login() {
    const account = await cid.createAccount({ username: `drone-owner-${++count}` });
    await cid.createOrganization("Fleet client", account.cid);
    const device = new VirtualAuthenticator(); const registration = cid.startAuthenticatorRegistration(account.cid, "passkey");
    const key = await cid.finishAuthenticatorRegistration(account.cid, device.create({challenge: registration.challenge, rpId: "localhost", origin: "http://localhost"}), {kind: "passkey"});
    const challenge = cid.startSignIn();
    const result = await cid.finishSignIn(device.get({credentialId: key.credentialId, challenge: challenge.challenge, origin: "http://localhost"}), "test");
    if (result.status !== "ok") throw new Error("Unexpected MFA");
    await cid.grant(account.cid, "LBRNTH", ["repo:read", "repo:write", "repo:admin"]);
    auth.provision(result.token); const repo = auth.forSession(result.token).createRepository("fleet");
    return {account, token: result.token, session: result.session, repo: repo.id};
  }
  const owner = await login(); const handle = droneBackend(auth);
  const request = (body: unknown, product = "daemon", token = owner.token, headers: Record<string, string> = {}) => handle(new Request(`https://fleet.example/api/drones/${product}`, {method: "POST", headers: {"content-type":"application/json", authorization: `Bearer ${token}`, ...headers}, body: JSON.stringify(body)}));
  const register = (repo = owner.repo, expectedHead: string | null = null, product = "daemon") => request({action:"register", repo, expectedHead, vehicle:"unit-1", systemId:1, componentId:1}, product);
  return {cid, auth, owner, login, request, register, handle, setPaid:(value: boolean) => {paid = value;}, expire:() => {now = new Date(now.getTime() + 31 * 86400000);}};
}
test("register, fleet listing and explicit log storage are real namespaced Labyrinth commits", async () => {
  const s = await setup(); const registration = await (await s.register()).json();
  assert.match(registration.id, /^[a-f0-9]{64}$/);
  assert.ok(registration.tree["products/daemon/fleet/unit-1.json"]);
  const fleet = await (await s.request({action:"fleet", repo:s.owner.repo})).json();
  assert.equal(fleet.vehicles[0].vehicle, "unit-1");
  const response = await s.request({action:"telemetry", repo:s.owner.repo, expectedHead:registration.id, vehicle:"unit-1", registrationCommit:registration.id, log:"flight-1", frames:frame().toString("base64")});
  assert.equal(response.status, 200); const commit = await response.json();
  const loaded = await s.request({action:"load", repo:s.owner.repo, commit:commit.id, kind:"logs", vehicle:"unit-1", artifact:"flight-1"});
  const artifact = await loaded.json(); assert.equal(artifact.observations.length, 1); assert.equal(artifact.controlAuthority, false);
});
test("all five products have isolated fleet namespaces; Flower is a base, not an aircraft", async () => {
  const s = await setup(); let head: string | null = null;
  for (const product of ["daemon", "slug", "orbis", "pollen", "flower"]) {
    const response = await s.register(s.owner.repo, head, product); assert.equal(response.status, 200);
    const commit = await response.json(); head = commit.id;
    assert.ok(commit.tree[`products/${product}/fleet/unit-1.json`]);
  }
});
test("stale heads conflict and cross-org or cross-product registration references cannot be loaded", async () => {
  const s = await setup(); const commit = await (await s.register()).json();
  assert.equal((await s.register()).status, 409);
  assert.equal((await s.request({action:"load", repo:s.owner.repo, commit:commit.id, kind:"fleet", vehicle:"unit-1"}, "pollen")).status, 404);
  const other = await s.login();
  assert.equal((await s.request({action:"fleet", repo:s.owner.repo}, "daemon", other.token)).status, 404);
});
test("raw identity, cookie-only calls, session revocation/expiry, plan revocation and consent denial fail closed", async () => {
  const s = await setup(); const body = {action:"fleet", repo:s.owner.repo};
  assert.equal((await s.request(body, "daemon", s.owner.account.cid)).status, 403);
  assert.equal((await s.handle(new Request("https://fleet.example/api/drones/daemon", {method:"POST", headers:{cookie:`cid=${s.owner.token}`, "content-type":"application/json"}, body:JSON.stringify(body)}))).status, 401);
  s.setPaid(false); assert.equal((await s.request(body)).status, 403); s.setPaid(true);
  await s.cid.revoke(s.owner.account.cid, "LBRNTH"); assert.equal((await s.request(body)).status, 403);
  await s.cid.grant(s.owner.account.cid, "LBRNTH", ["repo:read"]); assert.equal((await s.register()).status, 403);
  await s.cid.revokeSession(s.owner.account.cid, s.owner.session.id); assert.equal((await s.request(body)).status, 403);
  const expired = await setup(); expired.expire(); assert.equal((await expired.request({action:"fleet", repo:expired.owner.repo})).status, 403);
});
test("repository delegation remains revocable and does not become a general login", async () => {
  const s = await setup(); const delegated = s.auth.issueToken(s.owner.token);
  assert.equal((await s.request({action:"fleet", repo:s.owner.repo}, "daemon", delegated.token)).status, 200);
  await s.cid.revokeSession(s.owner.account.cid, s.owner.session.id);
  assert.equal((await s.request({action:"fleet", repo:s.owner.repo}, "daemon", delegated.token)).status, 403);
});
test("telemetry source mismatch, corrupt frames, noncanonical base64 and path traversal cannot write", async () => {
  const s = await setup(); const reg = await (await s.register()).json();
  const body = {action:"telemetry", repo:s.owner.repo, expectedHead:reg.id, registrationCommit:reg.id, vehicle:"unit-1", log:"test", frames:frame().toString("base64")};
  for (const patch of [{frames:"!!!"}, {vehicle:"../escape"}, {frames:frame().subarray(0, 10).toString("base64")}]) assert.equal((await s.request({...body, ...patch})).status, 400);
  const second = await s.request({action:"register", repo:s.owner.repo, expectedHead:reg.id, vehicle:"unit-2", systemId:2, componentId:1});
  const reg2 = await second.json(); assert.equal((await s.request({...body, expectedHead:reg2.id, registrationCommit:reg2.id, vehicle:"unit-2"})).status, 400);
});
test("lineage exposes product-specific commit provenance, not other product artifact paths", async () => {
  const s = await setup(); const reg = await (await s.register()).json();
  const other = await (await s.register(s.owner.repo, reg.id, "slug")).json();
  const result = await s.request({action:"lineage", repo:s.owner.repo});
  assert.equal(result.status, 200); const data = await result.json();
  assert.equal(data.commits[0].id, reg.id); assert.equal(data.commits[0].author, s.owner.account.cid);
  assert.ok(data.commits.every((c: {paths: string[]}) => c.paths.every(p => p.startsWith("products/daemon/"))));
  assert.ok(!JSON.stringify(data).includes("products/slug/")); assert.notEqual(other.id, reg.id);
});
test("HTTP rejects unknown actions/products, bad content, identity claims, oversized bodies and cross-origin requests", async () => {
  const s = await setup();
  for (const action of ["arm", "launch", "navigate", "mission", "validateMission", "target", "setMode"]) assert.equal((await s.request({action, repo:s.owner.repo})).status, 400);
  assert.equal((await s.request({action:"fleet", repo:s.owner.repo, orgId:"victim"})).status, 400);
  assert.equal((await s.request({}, "unknown")).status, 404);
  assert.equal((await s.request({}, "daemon", s.owner.token, {"content-type":"text/plain"})).status, 415);
  assert.equal((await s.request({}, "daemon", s.owner.token, {origin:"https://attacker.example"})).status, 403);
  const huge = await s.request({blob:"x".repeat(131073)}); assert.equal(huge.status, 413);
  assert.equal((await s.handle(new Request("https://fleet.example/api/drones/daemon"))).status, 405);
  const malformed = await s.handle(new Request("https://fleet.example/api/drones/daemon", {method:"POST", headers:{authorization:`Bearer ${s.owner.token}`, "content-type":"application/json"}, body:"{"}));
  assert.equal(malformed.status, 400); assert.equal(malformed.headers.get("cache-control"), "no-store");
});

test("chunked bodies cannot bypass the byte cap and malformed UTF-8 is refused", async () => {
  const s = await setup();
  const stream = new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new Uint8Array(70000)); controller.enqueue(new Uint8Array(70000)); controller.close();}});
  const init: RequestInit & {duplex:"half"} = {method:"POST", headers:{authorization:`Bearer ${s.owner.token}`, "content-type":"application/json"}, body:stream, duplex:"half"};
  assert.equal((await s.handle(new Request("https://fleet.example/api/drones/daemon", init))).status, 413);
  assert.equal((await s.handle(new Request("https://fleet.example/api/drones/daemon", {method:"POST", headers:{authorization:`Bearer ${s.owner.token}`, "content-type":"application/json"}, body:new Uint8Array([0xff])}))).status, 400);
});
test("archived logs remain versioned and duplicate uploads never confer live-flight authority", async () => {
  const s = await setup(); const reg = await (await s.register()).json();
  const body = {action:"telemetry", repo:s.owner.repo, expectedHead:reg.id, registrationCommit:reg.id, vehicle:"unit-1", log:"selected", frames:frame().toString("base64")};
  const first = await (await s.request(body)).json();
  assert.equal((await s.request(body)).status, 409);
  const next = await (await s.request({...body, expectedHead:first.id})).json();
  assert.equal(next.parent, first.id);
  const stored = await (await s.request({action:"load", repo:s.owner.repo, commit:first.id, kind:"logs", vehicle:"unit-1", artifact:"selected"})).json();
  assert.equal(stored.senderVerified, false); assert.equal(stored.controlAuthority, false);
});
