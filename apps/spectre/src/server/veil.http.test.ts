import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { CidService, FREE_ENTITLEMENTS } from "@infinitum/cid";
import { VirtualAuthenticator } from "../../../../packages/cid/src/testing/virtual-authenticator.ts";
import { SpectreCRM } from "../core/crm.ts";
import { createApp } from "./app.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = "http://localhost";
const SERVERS = [{ id: "iad-1", name: "Washington", region: "us-east", host: "veil-iad.example", port: 443, scheme: "https" as const }];
const BRIDGES = [
  "bridge obfs4 192.0.2.10:443 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA cert=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa iat-mode=0",
];

describe("VEIL Tor bridges on the Cumulus ID host", () => {
  let server: Server;
  let base: string;
  let cid: CidService;
  const entitled = new Set<string>();

  before(async () => {
    const signer = generateSigner();
    const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
    cid = new CidService({ ledger, signer, rpId: "localhost", origins: [ORIGIN] });
    const app = createApp({
      cid,
      crm: new SpectreCRM({ ledger, signer }),
      ai: {},
      publicDir: join(here, "../../public"),
      secureCookies: false,
      origin: ORIGIN,
      veil: { entitled: (account) => entitled.has(account), servers: SERVERS, bridges: BRIDGES },
    });
    server = app.server();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function signIn(username: string) {
    const auth = new VirtualAuthenticator();
    const headers = { "content-type": "application/json", "x-spectre": "1" };
    const signup = await fetch(`${base}/api/auth/signup`, { method: "POST", headers, body: JSON.stringify({ username }) });
    const started = await signup.json();
    const reg = auth.create({ challenge: started.options.challenge, origin: ORIGIN, rpId: "localhost" });
    const finished = await fetch(`${base}/api/auth/signup/finish`, {
      method: "POST", headers, body: JSON.stringify({ cid: started.cid, response: reg }),
    });
    const options = await finished.json();
    const credentialId = [...auth.credentials.keys()][0];
    const response = auth.get({ credentialId, challenge: options.options.challenge, origin: ORIGIN });
    const signed = await fetch(`${base}/api/auth/signin/finish`, {
      method: "POST", headers, body: JSON.stringify({ response }),
    });
    return { cookie: signed.headers.get("set-cookie")!.split(";")[0], cid: started.cid as string };
  }

  it("uses the existing CID session and does not treat a free account as a bridge plan", async () => {
    assert.equal("veil" in FREE_ENTITLEMENTS, false);
    const user = await signIn("veiluser");
    const headers = { "x-veil": "1", cookie: user.cookie };
    const session = await fetch(`${base}/api/veil/session`, { headers });
    assert.equal(session.status, 200);
    const body = await session.json();
    assert.equal(body.cid, user.cid);
    assert.equal(body.entitled, false);
    assert.equal(body.defaultMode, "veil");
    assert.deepEqual(body.servers, []);
    assert.equal(body.deviceWide, false);
    const blockedProxy = await fetch(`${base}/api/veil/connect`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ serverId: "iad-1" }),
    });
    assert.equal(blockedProxy.status, 403);
    const blockedDevice = await fetch(`${base}/api/veil/device/connect`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ serverId: "iad-1" }),
    });
    assert.equal(blockedDevice.status, 403);
    assert.equal((await blockedDevice.text()).includes("privateKey"), false);
    const blocked = await fetch(`${base}/api/veil/bridges`, { headers });
    assert.equal(blocked.status, 403);
    entitled.add(user.cid);
    const granted = await fetch(`${base}/api/veil/connect`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ serverId: "iad-1" }),
    });
    assert.equal(granted.status, 200);
    const credential = await granted.json();
    assert.equal(credential.coverage, "browser");
    assert.equal(credential.defaultMode, "veil");
    assert.equal(credential.dns, "through-proxy");
    assert.equal(credential.server.host, "veil-iad.example");
    const unconfigured = await fetch(`${base}/api/veil/device/connect`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ serverId: "iad-1" }),
    });
    assert.equal(unconfigured.status, 503);
    const unconfiguredBody = await unconfigured.json();
    assert.equal(unconfiguredBody.error, "device_exit_unconfigured");
    assert.equal(JSON.stringify(unconfiguredBody).includes("privateKey"), false);
    const allowed = await fetch(`${base}/api/veil/bridges`, { headers });
    const plan = await allowed.json();
    assert.deepEqual(plan.bridges, BRIDGES);
    assert.equal(plan.optional, true);
    await fetch(`${base}/api/auth/signout`, {
      method: "POST",
      headers: { ...headers, "x-spectre": "1", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal((await fetch(`${base}/api/veil/session`, { headers })).status, 401);
  });
});
