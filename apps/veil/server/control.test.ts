import { test } from "node:test";
import assert from "node:assert/strict";
import { FREE_ENTITLEMENTS } from "@infinitum/cid";
import { createVeilControl } from "./control.ts";
import { veilFromEnv } from "./env.ts";
import { veilFixture } from "./testing.ts";

test("a live Cumulus ID session without a VEIL plan cannot list exits or connect", async () => {
  const fx = await veilFixture();
  const user = await fx.login(false);
  assert.equal("veil" in FREE_ENTITLEMENTS, false);
  assert.equal(user.account.entitlements.mail, true);
  const session = fx.control.session(user.token);
  assert.equal(session.entitled, false);
  assert.deepEqual(session.servers, []);
  assert.equal(session.deviceWide, false);
  assert.throws(() => fx.control.connect(user.token, "iad-1"), /VEIL entitlement/);
  assert.equal(fx.control.authorizeProxy("v_not-a-real-user", "not-the-password"), false);
});

test("another product grant and a revoked session do not issue proxy credentials", async () => {
  const fx = await veilFixture();
  const user = await fx.login(false);
  await fx.cid.grant(user.account.cid, "spectre", ["crm:read"]);
  await fx.cid.grant(user.account.cid, "veil", ["proxy:connect"]);
  assert.equal(fx.control.session(user.token).entitled, false);
  fx.entitled.add(user.account.cid);
  assert.equal(fx.control.session(user.token).entitled, true);
  await fx.cid.revokeSession(user.account.cid, user.session.id);
  assert.throws(() => fx.control.session(user.token), /revoked/);
  assert.throws(() => fx.control.connect(user.token, "iad-1"), /revoked/);
});

test("entitled connect returns one browser proxy grant and retires the previous password", async () => {
  const fx = await veilFixture();
  const user = await fx.login(true);
  const other = await fx.login(true);
  const first = fx.control.connect(user.token, "iad-1");
  assert.equal(first.coverage, "browser");
  assert.equal(first.deviceWide, false);
  assert.equal(first.dns, "through-proxy");
  assert.equal(first.server.host, "veil-iad.example");
  assert.equal(first.server.scheme, "https");
  assert.equal(fx.control.authorizeProxy(first.auth.username, first.auth.password), true);
  const socks = fx.control.connect(user.token, "lhr-1");
  assert.equal(socks.server.scheme, "socks5");
  assert.equal(fx.control.authorizeProxy(first.auth.username, first.auth.password), false);
  assert.equal(fx.control.authorizeProxy(socks.auth.username, socks.auth.password), true);
  assert.equal(fx.control.authorizeProxy(socks.auth.username, other.token), false);
  const foreign = fx.control.connect(other.token, "iad-1");
  assert.equal(fx.control.authorizeProxy(socks.auth.username, socks.auth.password), true);
  assert.notEqual(foreign.auth.password, socks.auth.password);
});

test("dropping the plan, expiring the credential, or a thrown entitlement check fails closed", async () => {
  const fx = await veilFixture();
  const user = await fx.login(true);
  const grant = fx.control.connect(user.token, "iad-1");
  fx.entitled.delete(user.account.cid);
  assert.equal(fx.control.authorizeProxy(grant.auth.username, grant.auth.password), false);
  assert.throws(() => fx.control.connect(user.token, "iad-1"), /VEIL entitlement/);
  fx.entitled.add(user.account.cid);
  const renewed = fx.control.connect(user.token, "iad-1");
  fx.advance(16 * 60 * 1000);
  assert.equal(fx.control.authorizeProxy(renewed.auth.username, renewed.auth.password), false);
  assert.equal(fx.cid.authenticate(user.token)?.account.cid, user.account.cid);
  const again = fx.control.connect(user.token, "iad-1");
  assert.equal(fx.control.authorizeProxy(again.auth.username, again.auth.password), true);
  let blows = false;
  const hostile = createVeilControl({
    cid: fx.cid,
    servers: [{ id: "iad-1", name: "Washington", region: "us-east", host: "veil-iad.example", port: 443, scheme: "https" }],
    clock: () => new Date("2026-11-07T12:16:00Z"),
    entitled: () => {
      blows = true;
      throw new Error("entitlement backend down");
    },
  });
  assert.equal(hostile.session(user.token).entitled, false);
  assert.equal(blows, true);
  assert.throws(() => hostile.connect(user.token, "iad-1"), /VEIL entitlement/);
  fx.advance(31 * 24 * 60 * 60 * 1000);
  assert.throws(() => fx.control.connect(user.token, "iad-1"), /expired or revoked/);
});

test("catalog rejects proxy passwords, unsafe hosts, and non-proxy schemes", () => {
  assert.throws(() => createVeilControl({
    cid: {} as never,
    servers: [{ id: "bad", name: "X", region: "x", host: "169.254.169.254", port: 443, scheme: "https" }],
  }), /host/);
  assert.throws(() => createVeilControl({
    cid: {} as never,
    servers: [{ id: "bad", name: "X", region: "x", host: "user:pass@veil.example", port: 443, scheme: "https" }],
  }), /host/);
  assert.throws(() => createVeilControl({
    cid: {} as never,
    servers: [{ id: "bad", name: "X", region: "x", host: "veil.example", port: 443, scheme: "socks4" }],
  }), /scheme/);
  const config = veilFromEnv({});
  assert.deepEqual(config.servers, []);
  assert.equal(config.entitled("cid_anything"), false);
  const armed = veilFromEnv({
    VEIL_ENTITLED_CIDS: "cid_one, cid_two",
    VEIL_SERVERS: JSON.stringify([{ id: "iad-1", name: "Washington", region: "us-east", host: "veil-iad.example", port: 443, scheme: "https" }]),
  });
  assert.equal(armed.entitled("cid_one"), true);
  assert.equal(armed.entitled("cid_two"), true);
  assert.equal(armed.entitled("cid_three"), false);
  assert.equal(JSON.stringify(armed.servers).includes("password"), false);
  assert.throws(() => veilFromEnv({ VEIL_ENTITLED_CIDS: "alex" }), /invalid/);
  assert.throws(() => veilFromEnv({ VEIL_SERVERS: '{"password":"secret"}' }), /catalog|Server/);
});

test("disconnect revokes only that Cumulus ID", async () => {
  const fx = await veilFixture();
  const user = await fx.login(true);
  const other = await fx.login(true);
  const grant = fx.control.connect(user.token, "iad-1");
  const kept = fx.control.connect(other.token, "lhr-1");
  assert.deepEqual(fx.control.disconnect(user.token), { ok: true, deviceWide: false, browserOnly: true });
  assert.equal(fx.control.authorizeProxy(grant.auth.username, grant.auth.password), false);
  assert.equal(fx.control.authorizeProxy(kept.auth.username, kept.auth.password), true);
});
