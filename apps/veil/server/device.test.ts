import { test } from "node:test";
import assert from "node:assert/strict";
import { veilFixture } from "./testing.ts";
import { createVeilControl } from "./control.ts";
import { veilFromEnv } from "./env.ts";
import { veilHttp } from "./http.ts";
import { parseWireGuardKey, wireGuardKeyPair } from "./wireguard.ts";

const EXIT_TOKEN = "exit-token-value1";

function exitConfig(port = 51820) {
  const server = wireGuardKeyPair();
  return {
    server,
    exit: { publicKey: server.publicKey, host: "127.0.0.1", port, exitToken: EXIT_TOKEN },
  };
}

test("device grants require a VEIL plan and keep the client private key out of storage", async () => {
  const { server, exit } = exitConfig();
  const fx = await veilFixture(undefined, undefined, exit);
  const user = await fx.login(false);
  assert.equal(fx.control.deviceSession(user.token).entitled, false);
  assert.equal(fx.control.deviceSession(user.token).configured, false);
  assert.throws(() => fx.control.connectDevice(user.token, "iad-1"), /VEIL entitlement/);
  fx.entitled.add(user.account.cid);
  const session = fx.control.deviceSession(user.token);
  assert.equal(session.configured, true);
  assert.equal(session.deviceWide, true);
  assert.equal(session.defaultMode, "veil");
  assert.equal(session.dns, "through-tunnel");
  assert.equal(JSON.stringify(session).includes(server.privateKey), false);
  assert.equal(JSON.stringify(session).includes("127.0.0.1"), false);

  const grant = fx.control.connectDevice(user.token, "iad-1");
  assert.equal(grant.coverage, "device");
  assert.equal(grant.deviceWide, true);
  assert.equal(grant.browserOnly, false);
  assert.equal(grant.killSwitch, "fail-closed");
  assert.equal(grant.protection, "client-must-bring-up-tunnel");
  assert.equal(grant.peer.publicKey, server.publicKey);
  assert.equal(grant.peer.endpoint, "127.0.0.1:51820");
  assert.deepEqual(grant.peer.allowedIps, ["0.0.0.0/0", "::/0"]);
  assert.deepEqual(grant.interface.dns, ["10.64.0.1"]);
  assert.equal(grant.interface.address, "10.64.0.2/32");
  assert.equal(parseWireGuardKey(grant.interface.privateKey), grant.interface.privateKey);
  assert.notEqual(grant.interface.privateKey, grant.interface.publicKey);
  const stored = JSON.stringify(fx.control.deviceAudit());
  assert.equal(stored.includes(grant.interface.privateKey), false);
  assert.equal(stored.includes(server.privateKey), false);
  assert.equal(stored.includes(grant.interface.publicKey), true);

  const peers = fx.control.devicePeers(EXIT_TOKEN).peers;
  assert.equal(peers.length, 1);
  assert.equal(peers[0]?.publicKey, grant.interface.publicKey);
  assert.equal(JSON.stringify(peers).includes(grant.interface.privateKey), false);

  fx.control.disconnectDevice(user.token);
  assert.deepEqual(fx.control.devicePeers(EXIT_TOKEN).peers, []);
  assert.equal(fx.control.authorizeProxy("v_unused", "not-a-real-password"), false);
});

test("a revoked session, a dropped plan, and expiry remove the device peer", async () => {
  const { exit } = exitConfig();
  const fx = await veilFixture(undefined, undefined, exit);
  const user = await fx.login(true);
  const grant = fx.control.connectDevice(user.token, "lhr-1");
  fx.entitled.delete(user.account.cid);
  assert.deepEqual(fx.control.devicePeers(EXIT_TOKEN).peers, []);
  fx.entitled.add(user.account.cid);
  const again = fx.control.connectDevice(user.token, "lhr-1");
  assert.notEqual(again.interface.publicKey, grant.interface.publicKey);
  assert.equal(fx.control.deviceAudit().some((row) => row.publicKey === grant.interface.publicKey), false);
  await fx.cid.revokeSession(user.account.cid, user.session.id);
  assert.deepEqual(fx.control.devicePeers(EXIT_TOKEN).peers, []);
  assert.throws(() => fx.control.connectDevice(user.token, "lhr-1"), /revoked/);

  const live = await fx.login(true);
  fx.control.connectDevice(live.token, "iad-1");
  fx.advance(16 * 60 * 1000);
  assert.deepEqual(fx.control.devicePeers(EXIT_TOKEN).peers, []);
});

test("the exit peer list fails closed without the operator token", async () => {
  const { exit } = exitConfig();
  const fx = await veilFixture(undefined, undefined, exit);
  const user = await fx.login(true);
  fx.control.connectDevice(user.token, "iad-1");
  assert.throws(() => fx.control.devicePeers(""), /refused|Not found/);
  assert.throws(() => fx.control.devicePeers("exit-token-value2"), /refused/);
  const quiet = createVeilControl({
    cid: fx.cid,
    servers: [{ id: "iad-1", name: "Washington", region: "us-east", host: "veil-iad.example", port: 443, scheme: "https" }],
    deviceExit: { publicKey: exit.publicKey, host: "203.0.113.10", port: 51820 },
    entitled: () => true,
  });
  assert.throws(() => quiet.devicePeers(EXIT_TOKEN), /Not found/);
});

test("an unconfigured device exit does not invent a tunnel", async () => {
  const fx = await veilFixture();
  const user = await fx.login(true);
  assert.equal(fx.control.deviceSession(user.token).configured, false);
  assert.throws(() => fx.control.connectDevice(user.token, "iad-1"), /not configured/);
  assert.throws(() => veilFromEnv({ VEIL_WG_ENDPOINT: "203.0.113.10:51820" }), /requires/);
  assert.throws(() => veilFromEnv({
    VEIL_WG_SERVER_PUBLIC_KEY: "not-a-key",
    VEIL_WG_ENDPOINT: "203.0.113.10:51820",
  }), /invalid/);
  assert.throws(() => veilFromEnv({
    VEIL_WG_SERVER_PUBLIC_KEY: wireGuardKeyPair().publicKey,
    VEIL_WG_ENDPOINT: "169.254.169.254:51820",
  }), /host/);
  const armed = veilFromEnv({
    VEIL_WG_SERVER_PUBLIC_KEY: wireGuardKeyPair().publicKey,
    VEIL_WG_ENDPOINT: "veil-exit.example:51820",
    VEIL_EXIT_TOKEN: EXIT_TOKEN,
  });
  assert.equal(armed.deviceExit?.host, "veil-exit.example");
  assert.equal(armed.deviceExit?.port, 51820);
  assert.equal(JSON.stringify(armed.deviceExit).includes("private"), false);
});

test("HTTP device connect returns one private key and the exit list stays public-key only", async () => {
  const { server, exit } = exitConfig();
  const fx = await veilFixture(undefined, undefined, exit);
  const user = await fx.login(true);
  const handler = veilHttp(fx.control);
  const headers = { "x-veil": "1", authorization: `Bearer ${user.token}`, "content-type": "application/json" };
  const denied = await handler(new Request("https://cid.example/api/veil/device/connect", {
    method: "POST",
    headers,
    body: JSON.stringify({ serverId: "iad-1", privateKey: server.privateKey }),
  }));
  assert.equal(denied.status, 400);
  const ok = await handler(new Request("https://cid.example/api/veil/device/connect", {
    method: "POST",
    headers,
    body: JSON.stringify({ serverId: "iad-1" }),
  }));
  assert.equal(ok.status, 200);
  const body = await ok.json() as { interface: { privateKey: string; publicKey: string } };
  assert.equal(body.interface.privateKey.length > 40, true);
  assert.equal(JSON.stringify(body).includes(server.privateKey), false);
  const peers = await handler(new Request("https://cid.example/api/veil/device/peers", {
    headers: { "x-veil": "1", "x-veil-exit": EXIT_TOKEN },
  }));
  const listed = await peers.json() as { peers: Array<{ publicKey: string }> };
  assert.equal(listed.peers[0]?.publicKey, body.interface.publicKey);
  assert.equal(JSON.stringify(listed).includes(body.interface.privateKey), false);
  const missing = await handler(new Request("https://cid.example/api/veil/device/peers", {
    headers: { "x-veil": "1" },
  }));
  assert.equal(missing.status, 401);
});
