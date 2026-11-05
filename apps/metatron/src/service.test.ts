import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { Ledger, MemoryStore, generateSigner } from "@infinitum/firmament";
import { Vault } from "./vault.ts";
import { PlaidClient } from "./plaid.ts";
import { PaperBroker, BrokerError, type Broker } from "./broker.ts";
import { MemoryUserStore } from "./store.ts";
import { MetatronService, MetatronError } from "./service.ts";
import { createApp } from "./server.ts";
import type { Principal } from "./auth.ts";

const PRICES: Record<string, number> = { SPY: 700, EFA: 100, "BTC/USD": 80_000, XLK: 180, XLV: 190, XLF: 60, XLE: 60, XLP: 90 };

function fakePlaid() {
  const removed: string[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const b = JSON.parse(String(init.body));
    const ok = (x: unknown) => new Response(JSON.stringify(x));
    if (url.endsWith("/link/token/create")) return ok({ link_token: "link-sandbox-abc", expiration: "soon" });
    if (url.endsWith("/item/public_token/exchange")) return ok({ access_token: "access-sandbox-SECRET", item_id: "item-1" });
    if (url.endsWith("/accounts/balance/get")) return ok({ accounts: [{ account_id: "a1", name: "Checking", mask: "0000", type: "depository", subtype: "checking", balances: { current: 1200.5, available: 1100, limit: null, iso_currency_code: "USD" } }] });
    if (url.endsWith("/transactions/sync")) return ok({ added: b.cursor ? [] : [{ transaction_id: "t1", account_id: "a1", amount: 12.5, iso_currency_code: "USD", date: "2026-11-01", name: "Coffee", merchant_name: "Cafe", pending: false, personal_finance_category: { primary: "FOOD_AND_DRINK", detailed: "x" } }], modified: [], removed: [], next_cursor: "cur1", has_more: false });
    if (url.endsWith("/item/remove")) { removed.push(b.access_token); return ok({ request_id: "r" }); }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { client: new PlaidClient({ clientId: "c", secret: "s", env: "sandbox", fetchImpl: f }), removed };
}

function setup(clock = () => new Date("2026-11-05T12:00:00Z")) {
  const ledger = new Ledger(new MemoryStore());
  const signer = generateSigner();
  ledger.authorize(signer.publicKey);
  const store = new MemoryUserStore();
  const plaid = fakePlaid();
  // The "real" broker in tests is a paper simulator with its own state, standing in for Alpaca.
  const brokerState = PaperBroker.fresh(20_000);
  const brokerFactory = (c: { keyId: string }): Broker => {
    if (c.keyId !== "good-key") return { name: "alpaca", paper: true, account: async () => { throw new BrokerError("forbidden", 403); }, positions: async () => [], placeOrder: async () => { throw new Error("no"); } } as unknown as Broker;
    return new PaperBroker(brokerState, (s) => PRICES[s] ?? 0);
  };
  const svc = new MetatronService({ store, ledger, signer, vault: new Vault(Vault.generateKey()), plaid: plaid.client, brokerFactory, priceFeed: async (syms) => Object.fromEntries(syms.map((s) => [s, PRICES[s] ?? 0])), clock });
  return { svc, ledger, store, plaid, brokerState };
}

test("linking: single-use code, sealed token, balances, sync, revoke", async () => {
  const { svc, store, plaid, ledger } = setup();
  const { code } = svc.createLinkCode("cid-alex");
  assert.equal((await svc.linkToken(code)).linkToken, "link-sandbox-abc");
  const conn = await svc.exchange(code, "public-sandbox-1", "Northbank");
  await assert.rejects(svc.exchange(code, "public-sandbox-1", "Northbank"), /expired/, "a code can only be exchanged once");
  const raw = JSON.stringify(await store.get("cid-alex"));
  assert.ok(!raw.includes("access-sandbox-SECRET"), "access tokens are never stored in the clear");
  const { accounts } = await svc.accounts("cid-alex");
  assert.equal(accounts[0].current, 1200.5);
  assert.equal((await svc.transactions("cid-alex"))[0].name, "Cafe");
  await svc.removeConnection("cid-alex", conn.id);
  assert.deepEqual(plaid.removed, ["access-sandbox-SECRET"], "revoked at Plaid too");
  assert.equal((await svc.connections("cid-alex")).length, 0);
  const types = (await ledger.entries()).map((e) => e.type);
  assert.ok(types.includes("grant") && types.includes("revoke"));
  assert.equal((await ledger.verify()).ok, true);
});

test("broker keys are checked before they're saved, and stored sealed", async () => {
  const { svc, store } = setup();
  await assert.rejects(svc.connectBroker("cid-alex", { keyId: "bad", secret: "x", paper: true }), /rejected those keys/);
  await svc.connectBroker("cid-alex", { keyId: "good-key", secret: "super-secret", paper: true });
  assert.ok(!JSON.stringify(await store.get("cid-alex")).includes("super-secret"));
});

test("orders wait for approval, execute once, and are recorded", async () => {
  const { svc, ledger, brokerState } = setup();
  await svc.connectBroker("cid-alex", { keyId: "good-key", secret: "s", paper: true });
  const a = await svc.propose("cid-alex", { account: "broker", orders: [{ symbol: "SPY", side: "buy", notionalUsd: 1400 }], origin: "user" });
  assert.equal(a.status, "pending");
  assert.equal(brokerState.orders.length, 0, "nothing is sent before approval");
  const done = await svc.decide("cid-alex", a.id, "approve");
  assert.equal(done.status, "executed");
  assert.equal(brokerState.positions.SPY.qty, 2);
  await assert.rejects(svc.decide("cid-alex", a.id, "approve"), /already executed/);
  assert.equal(brokerState.orders.length, 1, "approving twice never places a second order");
  const pay = (await ledger.entries()).find((e) => e.type === "payment");
  assert.equal(pay?.payload.symbol, "SPY");
  assert.equal(pay?.actor, "cid-alex");
});

test("guardrails block at proposal and again at execution", async () => {
  const { svc } = setup();
  await svc.connectBroker("cid-alex", { keyId: "good-key", secret: "s", paper: true });
  await assert.rejects(
    svc.propose("cid-alex", { account: "broker", orders: [{ symbol: "SPY", side: "buy", notionalUsd: 9000 }], origin: "user" }),
    (e: unknown) => e instanceof MetatronError && e.status === 422 && !!e.reasons?.some((r) => /limit/.test(r)),
  );
  const a = await svc.propose("cid-alex", { account: "broker", orders: [{ symbol: "SPY", side: "buy", notionalUsd: 700 }], origin: "assistant" });
  await svc.setPolicy("cid-alex", { killSwitch: true });
  const r = await svc.decide("cid-alex", a.id, "approve");
  assert.equal(r.status, "failed");
  assert.match(r.results![0].error!, /kill switch/);
});

test("approvals expire", async () => {
  let t = new Date("2026-11-05T12:00:00Z");
  const { svc } = setup(() => t);
  await svc.connectBroker("cid-alex", { keyId: "good-key", secret: "s", paper: true });
  const a = await svc.propose("cid-alex", { account: "broker", orders: [{ symbol: "SPY", side: "buy", notionalUsd: 700 }], origin: "user" });
  t = new Date(t.getTime() + 16 * 60_000);
  await assert.rejects(svc.decide("cid-alex", a.id, "approve"), /already expired/);
});

test("a paper agent allowed to trade on its own fills at once; real-account agents always ask", async () => {
  const { svc } = setup();
  const r = await svc.runAgent("cid-alex", "momentum");
  // Momentum needs monthly returns from a connected broker; without one it proposes nothing.
  assert.equal(r.proposed, null);
  await svc.connectBroker("cid-alex", { keyId: "good-key", secret: "s", paper: true });
  const reb = await svc.runAgent("cid-alex", "rebalancer");
  assert.equal(reb.proposed?.status, "pending");
  assert.equal(reb.proposed?.origin, "agent");
  assert.match(reb.note, /capped at \$5000/, "agents shrink oversize orders to the limit instead of failing");
  await svc.updateAgent("cid-alex", "rebalancer", { account: "paper", autoPaper: true });
  const paper = await svc.runAgent("cid-alex", "rebalancer");
  assert.equal(paper.proposed?.status, "executed");
  const pf = await svc.portfolio("cid-alex", "paper");
  assert.ok(pf.positions.some((p) => p.symbol === "SPY"));
});

test("each person sees only their own ledger records", async () => {
  const { svc } = setup();
  await svc.setPolicy("cid-alex", { maxOrderUsd: 2000 });
  await svc.setPolicy("cid-bo", { maxOrderUsd: 3000 });
  const mine = await svc.ledgerFor("cid-alex");
  assert.ok(mine.length > 0 && mine.every((e) => e.actor === "cid-alex"));
});

/* ---------------- HTTP ---------------- */
async function serve(principal: Principal | null) {
  const { svc } = setup();
  const app = createApp({ service: svc, authenticate: (t) => (t === "tok-0123456789abcdef" ? principal : null), allowedOrigins: ["https://app.example"], publicOrigin: "https://api.example", clock: () => new Date("2026-11-05T12:00:00Z") });
  const server: Server = createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, init: RequestInit = {}, token = "tok-0123456789abcdef") =>
    fetch(base + path, { ...init, headers: { "Content-Type": "application/json", Origin: "https://app.example", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
  return { call, close: () => new Promise((r) => server.close(r)) };
}

test("http: sign-in required, CORS for allowed origins, guardrail reasons returned", async () => {
  const s = await serve({ cid: "cid-alex", sessionStartedAt: "2026-11-05T11:50:00Z", canRead: true, canTrade: true });
  try {
    assert.equal((await s.call("/api/policy", {}, "")).status, 401);
    const r = await s.call("/api/policy");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "https://app.example");
    const bad = await s.call("/api/orders", { method: "POST", body: JSON.stringify({ account: "paper", orders: [{ symbol: "SPY", side: "buy", notionalUsd: 99999 }] }) });
    assert.equal(bad.status, 422);
    assert.ok((await bad.json()).reasons.length > 0);
    const sess = await (await s.call("/api/link/session", { method: "POST", body: "{}" })).json();
    assert.match(sess.url, /^https:\/\/api\.example\/link#code=/);
    const page = await s.call("/link", {}, "");
    assert.match(page.headers.get("content-security-policy") ?? "", /cdn\.plaid\.com/);
  } finally { await s.close(); }
});

test("http: approving needs a recent sign-in and the trade permission", async () => {
  const stale = await serve({ cid: "cid-alex", sessionStartedAt: "2026-11-05T09:00:00Z", canRead: true, canTrade: true });
  try {
    const a = await (await stale.call("/api/orders", { method: "POST", body: JSON.stringify({ account: "paper", orders: [{ symbol: "SPY", side: "buy", notionalUsd: 700 }] }) })).json();
    const r = await stale.call(`/api/approvals/${a.id}/approve`, { method: "POST", body: "{}" });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, "reauth_required");
  } finally { await stale.close(); }
  const readOnly = await serve({ cid: "cid-alex", sessionStartedAt: "2026-11-05T11:59:00Z", canRead: true, canTrade: false });
  try {
    const r = await readOnly.call("/api/orders", { method: "POST", body: JSON.stringify({ account: "paper", orders: [{ symbol: "SPY", side: "buy", notionalUsd: 10 }] }) });
    assert.equal(r.status, 403);
  } finally { await readOnly.close(); }
});
