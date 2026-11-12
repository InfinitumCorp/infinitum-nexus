import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BillingLinkStore, RevenueClient, RevenueError, billingFor, effectiveEntitlements, extraStorageGb,
  type Entitlements, type ProductEntitlement,
} from "./index.ts";

function fakeApi() {
  const calls: { method: string; url: string; auth?: string; body?: any }[] = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", url, auth: headers.authorization, body });
    const path = new URL(url).pathname;
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (path === "/v1/signup") return json(201, { orgId: "org_1", apiKey: "ik_secret" });
    if (path === "/v1/subscriptions/checkout") return json(200, { id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" });
    if (path === "/v1/usage") return json(402, { error: { code: "allowance_exhausted", message: "Upgrade or buy credits" } });
    if (path === "/v1/billing/portal") return new Response("<html>bad gateway</html>", { status: 502 });
    return json(404, { error: { code: "not_found", message: "nope" } });
  };
  return { calls, fetch };
}

test("creates one billing org per CID and calls Checkout with its key", async () => {
  const api = fakeApi();
  const client = new RevenueClient({ baseUrl: "https://rev.test/", fetch: api.fetch });
  const store = new BillingLinkStore();
  const account = { cid: "cid_1", username: "ada", mailAddress: "ada@cumuluscloud.app" };
  const [billing] = await Promise.all([billingFor(client, store, account), billingFor(client, store, account)]);
  await billingFor(client, store, account);
  assert.equal(api.calls.filter((c) => c.url.endsWith("/v1/signup")).length, 1);
  assert.deepEqual(api.calls[0].body, { name: "ada", email: "ada@cumuluscloud.app", kind: "individual" });
  assert.equal(store.links.get("cid_1")?.orgId, "org_1");

  const s = await billing.subscriptionCheckout({ planId: "scalvs_pro", returnUrl: "https://scalvs.app/" });
  assert.equal(s.url, "https://checkout.stripe.com/c/cs_1");
  const last = api.calls.at(-1)!;
  assert.equal(last.url, "https://rev.test/v1/subscriptions/checkout");
  assert.equal(last.auth, "Bearer ik_secret");
  assert.deepEqual(last.body, { planId: "scalvs_pro", returnUrl: "https://scalvs.app/" });
});

test("surfaces API errors, including non-JSON ones", async () => {
  const api = fakeApi();
  const client = new RevenueClient({ apiKey: "ik", baseUrl: "https://rev.test", fetch: api.fetch });
  const err = await client.recordUsage({ meter: "scalvs_agent_task", quantity: 1, idempotencyKey: "k" }).catch((e) => e);
  assert.ok(err instanceof RevenueError);
  assert.equal(err.code, "allowance_exhausted");
  assert.equal(err.needsUpgrade, true);
  const err2 = await client.portal().catch((e) => e);
  assert.equal(err2.status, 502);
  assert.equal(err2.code, "http_error");
});

test("merges paid plans over the CID free tier", () => {
  const free = { storageGb: 15, scalvs: "free", architect: "free" };
  assert.deepEqual(effectiveEntitlements(free), {
    storageGb: 15, plans: { scalvs: "scalvs_free", architect: "cndctr_free" }, features: [], creditsCents: 0,
  });

  const p = (product: string, plan: string, status: string, extra: Partial<ProductEntitlement> = {}): ProductEntitlement =>
    ({ product, plan, status, seats: 1, features: [], overage: false, period: { start: "", end: "" }, meters: {}, ...extra });
  const ent: Entitlements = { orgId: "org_1", credits_cents: 500, products: [
    p("scalvs", "scalvs_pro", "active", { features: ["priority"] }),
    p("cndctr", "cndctr_free", "free"),
    p("cumulus", "cumulus_drive_200", "active", { meters: { cumulus_storage_gb_month: { included: 200, used: 3 } } }),
    p("firm_wallet", "firm_suite", "active"),
  ] };
  const eff = effectiveEntitlements(free, ent);
  assert.equal(eff.storageGb, 200);
  assert.equal(extraStorageGb(15, eff), 185);
  assert.equal(eff.plans.scalvs, "scalvs_pro");
  assert.equal(eff.plans.architect, "cndctr_free");
  assert.equal(eff.plans.cloud, "cumulus_drive_200");
  assert.equal(eff.plans.firmWallet, "firm_suite");
  assert.deepEqual(eff.features, ["priority"]);
  assert.equal(eff.creditsCents, 500);

  // The revenue catalog's 5 GB free drive never shrinks the CID's 15 GB.
  const small = effectiveEntitlements(free, { orgId: "o", credits_cents: 0,
    products: [p("cumulus", "cumulus_drive_free", "free", { meters: { cumulus_storage_gb_month: { included: 5, used: 0 } } })] });
  assert.equal(small.storageGb, 15);
});

test("with a partner key the hub uses the revenue API's own Cumulus ID mapping", async () => {
  const PARTNER = "p".repeat(40);
  const seen: { path: string; headers: Record<string, string> }[] = [];
  let linkAnswer: { status: number; body: unknown } = { status: 200, body: { linked: true, orgId: "org_old" } };
  const fetch = async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const path = new URL(url).pathname;
    seen.push({ path, headers });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (path === "/v1/me/cid-link") return json(linkAnswer.status, linkAnswer.body);
    if (path === "/v1/subscriptions/checkout") return json(200, { id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" });
    return json(404, { error: { code: "not_found", message: "nope" } });
  };
  const client = new RevenueClient({ baseUrl: "https://rev.test", fetch, cidPartnerKey: PARTNER });
  const store = new BillingLinkStore();
  const ada = { cid: "cid_ada", username: "ada", mailAddress: "ada@cumuluscloud.app" };

  // No old org: no signup, the call goes out as the Cumulus ID.
  await (await billingFor(client, store, ada)).subscriptionCheckout({ planId: "scalvs_pro" });
  const co = seen.find((s) => s.path === "/v1/subscriptions/checkout")!;
  assert.equal(co.headers.authorization, `Bearer ${PARTNER}`);
  assert.equal(co.headers["x-cumulus-id"], "cid_ada");
  assert.ok(!seen.some((s) => s.path === "/v1/signup"));

  // An org the hub made before is handed over once, with its own key plus the partner key.
  const bob = { cid: "cid_bob", username: "bob", mailAddress: "bob@cumuluscloud.app" };
  store.links.set("cid_bob", { cid: "cid_bob", orgId: "org_old", apiKey: "ik_old", linkedAt: "2026-11-01" });
  seen.length = 0;
  await billingFor(client, store, bob);
  await billingFor(client, store, bob);
  const links = seen.filter((s) => s.path === "/v1/me/cid-link");
  assert.equal(links.length, 1);
  assert.equal(links[0]!.headers.authorization, "Bearer ik_old");
  assert.equal(links[0]!.headers["x-cid-partner-key"], PARTNER);
  assert.equal(store.links.get("cid_bob")!.handedOver, "linked");

  // Already linked elsewhere: the revenue mapping wins, the old org is marked superseded.
  const cy = { cid: "cid_cy", username: "cy", mailAddress: "cy@cumuluscloud.app" };
  store.links.set("cid_cy", { cid: "cid_cy", orgId: "org_cy_old", apiKey: "ik_cy", linkedAt: "2026-11-01" });
  linkAnswer = { status: 409, body: { error: { code: "cid_already_linked", message: "taken" } } };
  seen.length = 0;
  await (await billingFor(client, store, cy)).subscriptionCheckout({ planId: "scalvs_pro" });
  assert.equal(store.links.get("cid_cy")!.handedOver, "superseded");
  assert.equal(seen.find((s) => s.path === "/v1/subscriptions/checkout")!.headers["x-cumulus-id"], "cid_cy");

  // Revenue down during handover: keep working on the old org, try again next time.
  const dee = { cid: "cid_dee", username: "dee", mailAddress: "dee@cumuluscloud.app" };
  store.links.set("cid_dee", { cid: "cid_dee", orgId: "org_dee", apiKey: "ik_dee", linkedAt: "2026-11-01" });
  linkAnswer = { status: 503, body: { error: { code: "unavailable", message: "down" } } };
  seen.length = 0;
  await (await billingFor(client, store, dee)).subscriptionCheckout({ planId: "scalvs_pro" });
  assert.equal(seen.find((s) => s.path === "/v1/subscriptions/checkout")!.headers.authorization, "Bearer ik_dee");
  assert.equal(store.links.get("cid_dee")!.handedOver, undefined);
});

test("a short partner key is ignored", () => {
  assert.equal(new RevenueClient({ cidPartnerKey: "short" }).cidPartnerKey, undefined);
});
