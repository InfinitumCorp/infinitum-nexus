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
