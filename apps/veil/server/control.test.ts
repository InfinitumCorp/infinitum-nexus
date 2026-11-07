import { test } from "node:test";
import assert from "node:assert/strict";
import { FREE_ENTITLEMENTS } from "@infinitum/cid";
import { createVeilControl } from "./control.ts";
import { veilFromEnv } from "./env.ts";
import { veilFixture, VEIL_BRIDGES } from "./testing.ts";

test("a live Cumulus ID session without a VEIL plan cannot read bridges", async () => {
  const fx = await veilFixture();
  const user = await fx.login(false);
  assert.equal("veil" in FREE_ENTITLEMENTS, false);
  const session = fx.control.session(user.token);
  assert.equal(session.entitled, false);
  assert.equal(session.routing, "local-tor");
  assert.equal(session.deviceWide, false);
  assert.equal(JSON.stringify(session).includes("192.0.2.10"), false);
  assert.equal(JSON.stringify(session).includes("password"), false);
  assert.throws(() => fx.control.bridges(user.token), /VEIL entitlement/);
});

test("another product grant and a revoked session do not publish bridges", async () => {
  const fx = await veilFixture();
  const user = await fx.login(false);
  await fx.cid.grant(user.account.cid, "spectre", ["crm:read"]);
  await fx.cid.grant(user.account.cid, "veil", ["proxy:connect"]);
  assert.equal(fx.control.session(user.token).entitled, false);
  fx.entitled.add(user.account.cid);
  assert.deepEqual(fx.control.bridges(user.token).bridges, VEIL_BRIDGES);
  await fx.cid.revokeSession(user.account.cid, user.session.id);
  assert.throws(() => fx.control.session(user.token), /revoked/);
  assert.throws(() => fx.control.bridges(user.token), /revoked/);
});

test("a thrown entitlement check fails closed and does not reveal bridges", async () => {
  const fx = await veilFixture();
  const user = await fx.login(true);
  let blows = false;
  const hostile = createVeilControl({
    cid: fx.cid,
    bridges: VEIL_BRIDGES,
    entitled: () => {
      blows = true;
      throw new Error("entitlement backend down");
    },
  });
  assert.equal(hostile.session(user.token).entitled, false);
  assert.equal(blows, true);
  assert.throws(() => hostile.bridges(user.token), /VEIL entitlement/);
  fx.advance(31 * 24 * 60 * 60 * 1000);
  assert.throws(() => fx.control.bridges(user.token), /expired or revoked/);
});

test("bridge config rejects proxy passwords, private keys, and remote routing instructions", () => {
  assert.throws(() => createVeilControl({
    cid: {} as never,
    bridges: ["https://user:pass@veil.example"],
  }), /bridge/i);
  assert.throws(() => createVeilControl({
    cid: {} as never,
    bridges: ["-----BEGIN PRIVATE KEY-----\nabc"],
  }), /refused|bridge/i);
  const config = veilFromEnv({});
  assert.deepEqual(config.bridges, []);
  assert.equal(config.entitled("cid_anything"), false);
  const armed = veilFromEnv({
    VEIL_ENTITLED_CIDS: "cid_one, cid_two",
    VEIL_BRIDGES: JSON.stringify(VEIL_BRIDGES),
  });
  assert.equal(armed.entitled("cid_one"), true);
  assert.equal(armed.entitled("cid_three"), false);
  assert.equal(armed.bridges.length, 1);
  assert.throws(() => veilFromEnv({ VEIL_ENTITLED_CIDS: "alex" }), /invalid/);
  assert.throws(() => veilFromEnv({ VEIL_BRIDGES: '{"password":"secret"}' }), /list|Bridge/);
});
