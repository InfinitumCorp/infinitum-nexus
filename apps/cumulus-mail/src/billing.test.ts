import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { join } from "node:path";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { createCumulus } from "@infinitum/cumulus";
import { BillingLinkStore, RevenueClient } from "@infinitum/billing";
import { VirtualAuthenticator } from "../../../packages/cid/src/testing/virtual-authenticator.ts";
import { createMailApp } from "./app.ts";
import { MILITARY_PRODUCTS, SELLABLE, returnUrlFor } from "./billing.ts";

// A stand-in for the revenue API: records what Mail asked for and answers like the real one.
const calls: { method: string; path: string; auth: string | null; body: any }[] = [];
let signups = 0;
let fail: number | null = null;
let checkoutUrl = "https://checkout.stripe.com/c/pay/cs_test_abc";
const fakeFetch = async (url: string, init?: RequestInit) => {
  const path = new URL(url).pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method: init?.method ?? "GET", path, auth: (init?.headers as any)?.authorization ?? null, body });
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  if (fail) return json(fail, { error: { code: "plan_not_allowed", message: "This plan is for business accounts." } });
  if (path === "/v1/signup") return json(200, { orgId: `org_${++signups}`, apiKey: `key_${signups}` });
  if (path === "/v1/me/org") return json(200, { id: "org_x", name: "x", kind: body.kind ?? "individual" });
  if (path === "/v1/subscriptions/checkout") return json(200, { id: "cs_test_abc", url: checkoutUrl });
  if (path === "/v1/billing/portal") return json(200, { url: "https://billing.stripe.com/p/session/test_123" });
  if (path === "/v1/me/entitlements") return json(200, { orgId: "org_1", credits_cents: 500, products: [
    { product: "scalvs", plan: "scalvs_pro", status: "active", seats: 1, features: ["scalvs.priority"], overage: true, period: { start: "2026-11-10", end: "2026-12-10" }, meters: {} },
  ] });
  return json(404, { error: { code: "not_found", message: "Not found" } });
};

let base = "";
let server: ReturnType<ReturnType<typeof createMailApp>["server"]>;
const billingStore = new BillingLinkStore();

before(async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  base = `http://localhost:${port}`;
  const signer = generateSigner();
  const suite = createCumulus({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "localhost", origins: [base], mailOrigin: base });
  server = createMailApp({
    suite, publicDir: join(import.meta.dirname, "..", "public"), origin: base, secureCookies: false,
    billingStore, revenue: new RevenueClient({ baseUrl: "https://revenue.test", fetch: fakeFetch }),
  }).server();
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
});
after(() => new Promise<void>((r) => server.close(() => r())));

const call = async (path: string, cookie = "", headers: Record<string, string> = {}) => {
  const res = await fetch(base + path, { headers: { cookie, ...headers }, redirect: "manual" });
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: data, location: res.headers.get("location"), headers: res.headers };
};

async function signUp(username: string) {
  const auth = new VirtualAuthenticator();
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-cumulus": "1" }, body: JSON.stringify(body) });
  const a = (await (await post("/api/auth/signup", { username })).json()) as any;
  const b = (await (await post("/api/auth/signup/finish", { cid: a.cid, response: auth.create({ challenge: a.options.challenge, origin: base, rpId: "localhost" }) })).json()) as any;
  const c = await post("/api/auth/signin/finish", { response: auth.get({ credentialId: b.options.allowCredentials[0].id, challenge: b.options.challenge, origin: base }) });
  return c.headers.get("set-cookie")!.split(";")[0]!;
}

describe("Buying Infinitum products with a Cumulus://ID", () => {
  it("signed out: sign in first; signed in: one billing org, then Stripe Checkout", async () => {
    const q = new URLSearchParams({ plan: "scalvs_pro", return: "https://scalvs.app/thanks" });
    const out = await call(`/api/billing/subscribe?${q}`);
    assert.equal(out.status, 302);
    assert.match(out.location!, /^\/\?next=%2Fapi%2Fbilling%2Fsubscribe%3Fplan%3Dscalvs_pro/);
    assert.match(out.location!, /for=SCALVS\.ai/);
    assert.equal(calls.length, 0, "nothing is created before sign-in");

    const me = await signUp("buyer");
    const go = await call(`/api/billing/subscribe?${q}`, me);
    assert.equal(go.status, 302);
    assert.equal(go.location, checkoutUrl);
    const checkout = calls.find((c) => c.path === "/v1/subscriptions/checkout")!;
    assert.deepEqual(checkout.body, { planId: "scalvs_pro", returnUrl: "https://scalvs.app/thanks" });
    assert.equal(checkout.auth, "Bearer key_1", "checkout runs as the buyer's own billing org");
    assert.equal(calls.filter((c) => c.path === "/v1/signup").length, 1);
    assert.equal(calls.find((c) => c.path === "/v1/signup")!.body.kind, "individual");

    // A second purchase reuses the same billing org.
    await call(`/api/billing/subscribe?${new URLSearchParams({ plan: "cumulus_drive_200", return: "https://cumuluscloud.app/" })}`, me);
    assert.equal(calls.filter((c) => c.path === "/v1/signup").length, 1);
    assert.equal(billingStore.links.size, 1);
  });

  it("only sells public self-serve plans, never military products", async () => {
    const me = await signUp("buyer2");
    for (const plan of ["orbis_fleet", "eon_plus", "eidetic_enterprise", "pollen_fleet", "slug_raas", "odin_suite", "scalvs_private", "scalvs_free", "nope"]) {
      const res = await call(`/api/billing/subscribe?plan=${plan}`, me);
      assert.equal(res.status, 400, plan);
    }
    for (const plan of Object.keys(SELLABLE)) assert.ok(!MILITARY_PRODUCTS.has(plan.split("_")[0]!), plan);
  });

  it("returns only to Infinitum product sites, and only sends people to Stripe", async () => {
    assert.equal(returnUrlFor("https://evil.example/x", "https://infinitumcorporation.ai/"), "https://infinitumcorporation.ai/");
    assert.equal(returnUrlFor("https://user:pw@scalvs.app/", "https://infinitumcorporation.ai/"), "https://infinitumcorporation.ai/");
    assert.equal(returnUrlFor("https://mttrn.app/plans#x", "x"), "https://mttrn.app/plans");
    const me = await signUp("buyer3");
    calls.length = 0;
    await call(`/api/billing/subscribe?${new URLSearchParams({ plan: "metatron_personal", return: "https://evil.example/" })}`, me);
    assert.equal(calls.find((c) => c.path === "/v1/subscriptions/checkout")!.body.returnUrl, "https://infinitumcorporation.ai/");

    checkoutUrl = "https://evil.example/pay";
    assert.equal((await call("/api/billing/subscribe?plan=metatron_personal", me)).status, 502);
    checkoutUrl = "https://checkout.stripe.com/c/pay/cs_test_abc";
  });

  it("revenue errors come back as a clear message, not a crash", async () => {
    const me = await signUp("buyer4");
    fail = 400;
    const res = await call("/api/billing/subscribe?plan=cndctr_pro", me);
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /business accounts/);
    fail = 503;
    assert.equal((await call("/api/billing/subscribe?plan=cndctr_pro", me)).status, 503);
    fail = null;
  });

  it("business plans switch the buyer to a business org first and take seats", async () => {
    const me = await signUp("buyer6");
    calls.length = 0;
    const res = await call("/api/billing/subscribe?plan=spectre_growth&seats=12", me);
    assert.equal(res.status, 302);
    const org = calls.findIndex((c) => c.path === "/v1/me/org");
    const co = calls.findIndex((c) => c.path === "/v1/subscriptions/checkout");
    assert.ok(org >= 0 && org < co, "org becomes business before checkout");
    assert.equal(calls[org]!.body.kind, "business");
    assert.equal(calls[co]!.body.quantity, 12);
    calls.length = 0;
    await call("/api/billing/subscribe?plan=metatron_business&seats=40", me);
    assert.equal(calls.find((c) => c.path === "/v1/subscriptions/checkout")!.body.quantity, undefined, "flat business plan has no seats");
    calls.length = 0;
    await call("/api/billing/subscribe?plan=scalvs_pro&seats=5", me);
    assert.equal(calls.some((c) => c.path === "/v1/me/org"), false, "individual plans leave the org alone");
    assert.equal(calls.find((c) => c.path === "/v1/subscriptions/checkout")!.body.quantity, undefined);
  });

  it("manage opens the Stripe portal; me reports what the CID pays for", async () => {
    const me = await signUp("buyer5");
    assert.equal((await call("/api/billing/manage")).status, 302);
    const before = await call("/api/billing/me", me);
    assert.deepEqual(before.body.products, [], "no billing org yet: nothing bought, and none is created just to look");
    await call("/api/billing/subscribe?plan=scalvs_pro", me);
    const portal = await call(`/api/billing/manage?${new URLSearchParams({ return: "https://scalvs.app/account" })}`, me);
    assert.equal(portal.location, "https://billing.stripe.com/p/session/test_123");
    const after = await call("/api/billing/me", me, { origin: "https://scalvs.app" });
    assert.equal(after.status, 200);
    assert.equal(after.body.plans.scalvs, "scalvs_pro");
    assert.deepEqual(after.body.features, ["scalvs.priority"]);
    assert.equal(after.body.products[0].renews, "2026-12-10");
    assert.equal(after.headers.get("access-control-allow-origin"), "https://scalvs.app");
    assert.equal((await call("/api/billing/me")).status, 401);
  });
});
