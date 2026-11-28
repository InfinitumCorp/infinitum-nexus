import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { createCumulus } from "@infinitum/cumulus";
import { RevenueClient } from "@infinitum/billing";
import { billingEnabled, createMailApp } from "./app.ts";

// MAIL_BILLING=off: the Russia copy, where Stripe isn't available. Nothing may reach the revenue API.
let revenueCalls = 0;
const revenue = new RevenueClient({
  baseUrl: "https://revenue.test",
  fetch: async () => {
    revenueCalls++;
    return new Response("{}", { status: 500 });
  },
});

let base = "";
let server: ReturnType<ReturnType<typeof createMailApp>["server"]>;

before(async () => {
  const signer = generateSigner();
  const placeholder = "http://localhost:0";
  const suite = createCumulus({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "localhost", origins: [placeholder], mailOrigin: placeholder });
  server = createMailApp({ suite, publicDir: join(import.meta.dirname, "..", "public"), origin: placeholder, secureCookies: false, revenue, billing: false, noTimers: true }).server();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

describe("MAIL_BILLING=off", () => {
  it("reads the switch from the environment; on unless set to off", () => {
    assert.equal(billingEnabled({}), true);
    assert.equal(billingEnabled({ MAIL_BILLING: "on" }), true);
    for (const off of ["off", "OFF", "false", "0", "no", " off "]) assert.equal(billingEnabled({ MAIL_BILLING: off }), false, off);
  });

  it("has no billing routes and never calls the revenue API", async () => {
    for (const path of ["/api/billing/subscribe?plan=scalvs_pro&return=https://scalvs.app/", "/api/billing/manage?return=https://scalvs.app/", "/api/billing/me"]) {
      const res = await fetch(base + path, { redirect: "manual", headers: { authorization: "Bearer not-a-token" } });
      assert.equal(res.status, 404, path);
      await res.arrayBuffer();
    }
    assert.equal(revenueCalls, 0);
  });

  it("the rest of Mail still answers", async () => {
    const res = await fetch(`${base}/api/auth/issuer`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { issuer: null });
  });
});
