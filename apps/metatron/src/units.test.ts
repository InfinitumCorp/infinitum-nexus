import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Vault } from "./vault.ts";
import { DEFAULT_POLICY, checkOrder, normalizePolicy } from "./guardrails.ts";
import { planDca, planMomentum, planRebalance, DEFAULT_AGENTS } from "./agents.ts";
import { PlaidClient, PlaidError } from "./plaid.ts";
import { AlpacaBroker } from "./broker.ts";

/* ---------------- Vault ---------------- */
test("vault seals and opens, bound to its owner", () => {
  const v = new Vault(Vault.generateKey());
  const s = v.seal("access-sandbox-123", "cid1|conn1");
  assert.ok(!JSON.stringify(s).includes("access-sandbox-123"));
  assert.equal(v.open(s, "cid1|conn1"), "access-sandbox-123");
  assert.throws(() => v.open(s, "cid2|conn1"), "another user's record must not decrypt");
  assert.throws(() => new Vault("short"), /32 random bytes/);
});

/* ---------------- Guardrails ---------------- */
const ctx = { ordersToday: 0, dayPlUsd: 0, buyingPower: 10_000, heldUsd: 0 };
test("guardrails allow a normal order", () => {
  assert.deepEqual(checkOrder({ symbol: "SPY", side: "buy", notionalUsd: 500 }, "agent", ctx, DEFAULT_POLICY), { ok: true, reasons: [] });
});
test("guardrails block oversize, over-count, no cash and selling what you don't hold", () => {
  const r = checkOrder({ symbol: "SPY", side: "buy", notionalUsd: 20_000 }, "user", { ...ctx, ordersToday: 10 }, DEFAULT_POLICY);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /over the \$5000 limit/.test(x)));
  assert.ok(r.reasons.some((x) => /Daily limit/.test(x)));
  assert.ok(r.reasons.some((x) => /buying power/.test(x)));
  assert.ok(checkOrder({ symbol: "EFA", side: "sell", notionalUsd: 10 }, "user", ctx, DEFAULT_POLICY).reasons.some((x) => /don't hold/.test(x)));
});
test("kill switch, allow-list and loss limit stop automated orders but not the person", () => {
  const p = { ...DEFAULT_POLICY, killSwitch: true };
  const o = { symbol: "TSLA", side: "buy" as const, notionalUsd: 100 };
  const bad = { ...ctx, dayPlUsd: -5_000 };
  assert.equal(checkOrder(o, "user", bad, p).ok, true);
  const r = checkOrder(o, "assistant", bad, p);
  assert.ok(r.reasons.some((x) => /kill switch/.test(x)));
  assert.ok(r.reasons.some((x) => /allowed list/.test(x)));
  assert.ok(r.reasons.some((x) => /loss passed/.test(x)));
});
test("policy input is clamped and cleaned", () => {
  const p = normalizePolicy({ maxOrderUsd: -5, maxDailyOrders: 9999, allowedSymbols: ["spy", "bad symbol!", "btc/usd"] as string[] });
  assert.equal(p.maxOrderUsd, 1);
  assert.equal(p.maxDailyOrders, 200);
  assert.deepEqual(p.allowedSymbols, ["SPY", "BTC/USD"]);
});

/* ---------------- Agents ---------------- */
const pos = (symbol: string, marketValue: number) => ({ symbol, qty: 1, avgEntry: marketValue, marketValue, currentPrice: marketValue, unrealizedPl: 0 });
test("rebalancer sells what's over target and buys what's under, sells first", () => {
  const a = DEFAULT_AGENTS[0];
  const plan = planRebalance(a, [pos("SPY", 9_000), pos("EFA", 500), pos("XLE", 300)], 200);
  assert.equal(plan.orders[0].side, "sell");
  const by = Object.fromEntries(plan.orders.map((o) => [`${o.side}:${o.symbol}`, o.notionalUsd]));
  assert.ok(by["sell:SPY"] > 0 && by["buy:EFA"] > 0 && by["buy:BTC/USD"] > 0 && by["sell:XLE"] === 300);
});
test("momentum holds the strongest symbols", () => {
  const a = DEFAULT_AGENTS[1];
  const plan = planMomentum(a, [pos("XLE", 4_000)], 6_000, { XLK: -11, XLV: 12, XLF: 9, XLE: -1, XLP: 13 });
  assert.deepEqual(plan.orders.map((o) => `${o.side}:${o.symbol}`).sort(), ["buy:XLP", "buy:XLV", "sell:XLE"]);
  assert.match(plan.note, /XLP \+13\.0%/);
});
test("dca buys its fixed amount", () => {
  assert.deepEqual(planDca(DEFAULT_AGENTS[2]).orders, [{ symbol: "BTC/USD", side: "buy", notionalUsd: 250 }]);
});

/* ---------------- Plaid ---------------- */
function fakeFetch(handler: (url: string, body: any, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; body: any }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const r = handler(url, body, init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

test("plaid: link token carries credentials, products and countries", async () => {
  const { f, calls } = fakeFetch(() => ({ body: { link_token: "link-sandbox-1", expiration: "x" } }));
  const p = new PlaidClient({ clientId: "cid", secret: "sec", env: "sandbox", countryCodes: ["US", "NL"], fetchImpl: f });
  await p.createLinkToken("user-1", { investments: true });
  assert.equal(calls[0].url, "https://sandbox.plaid.com/link/token/create");
  assert.equal(calls[0].body.client_id, "cid");
  assert.deepEqual(calls[0].body.country_codes, ["US", "NL"]);
  assert.deepEqual(calls[0].body.optional_products, ["investments"]);
});
test("plaid: transactions sync follows pages and errors carry Plaid's code", async () => {
  let n = 0;
  const { f } = fakeFetch((url) => {
    if (url.endsWith("/accounts/balance/get")) return { status: 400, body: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "login" } };
    n++;
    return { body: { added: [{ transaction_id: "t" + n }], modified: [], removed: [], next_cursor: "c" + n, has_more: n < 3 } };
  });
  const p = new PlaidClient({ clientId: "a", secret: "b", env: "sandbox", fetchImpl: f });
  const r = await p.syncTransactions("tok");
  assert.equal(r.added.length, 3);
  assert.equal(r.nextCursor, "c3");
  await assert.rejects(p.getBalances("tok"), (e: unknown) => e instanceof PlaidError && e.code === "ITEM_LOGIN_REQUIRED");
});
test("plaid: webhook signatures are verified (body hash, age, signature)", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const { f } = fakeFetch(() => ({ body: { key: { ...jwk, alg: "ES256", kid: "k1", use: "sig", expired_at: null } } }));
  const now = new Date("2026-11-05T12:00:00Z");
  const p = new PlaidClient({ clientId: "a", secret: "b", env: "sandbox", fetchImpl: f, clock: () => now });
  const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item1" });
  const jwt = (claims: object) => {
    const h = Buffer.from(JSON.stringify({ alg: "ES256", kid: "k1", typ: "JWT" })).toString("base64url");
    const c = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const s = sign("sha256", Buffer.from(h + "." + c), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    return `${h}.${c}.${s}`;
  };
  const iat = Math.floor(now.getTime() / 1000) - 10;
  const sha = createHash("sha256").update(body).digest("hex");
  assert.equal(await p.verifyWebhook(body, jwt({ iat, request_body_sha256: sha })), true);
  assert.equal(await p.verifyWebhook(body + " ", jwt({ iat, request_body_sha256: sha })), false, "tampered body");
  assert.equal(await p.verifyWebhook(body, jwt({ iat: iat - 600, request_body_sha256: sha })), false, "too old");
  assert.equal(await p.verifyWebhook(body, jwt({ iat, request_body_sha256: sha }).slice(0, -4) + "AAAA"), false, "bad signature");
  assert.equal(await p.verifyWebhook(body, undefined), false);
});

/* ---------------- Alpaca ---------------- */
test("alpaca: market orders by dollar amount, crypto good-till-cancelled, idempotent retries", async () => {
  const sent: any[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    if (url.includes("by_client_order_id")) return new Response(JSON.stringify({ id: "o-existing", client_order_id: "apv_1-0", symbol: "BTC/USD", side: "buy", status: "filled", notional: "250", filled_qty: "0.003", filled_avg_price: "80000" }));
    const body = JSON.parse(String(init.body));
    sent.push({ url, body, headers: init.headers });
    if (sent.length === 2) return new Response(JSON.stringify({ message: "client_order_id must be unique" }), { status: 422 });
    return new Response(JSON.stringify({ id: "o1", client_order_id: body.client_order_id, symbol: body.symbol, side: body.side, status: "accepted", notional: body.notional, filled_qty: "0" }));
  }) as unknown as typeof fetch;
  const b = new AlpacaBroker({ keyId: "k", secret: "s", paper: true, fetchImpl: f });
  const o = await b.placeOrder({ symbol: "SPY", side: "buy", notionalUsd: 1000, clientOrderId: "apv_0-0" });
  assert.equal(sent[0].url, "https://paper-api.alpaca.markets/v2/orders");
  assert.deepEqual([sent[0].body.type, sent[0].body.time_in_force, sent[0].body.notional], ["market", "day", "1000.00"]);
  assert.equal((sent[0].headers as Record<string, string>)["APCA-API-KEY-ID"], "k");
  assert.equal(o.status, "accepted");
  const again = await b.placeOrder({ symbol: "BTC/USD", side: "buy", notionalUsd: 250, clientOrderId: "apv_1-0" });
  assert.equal(sent[1].body.time_in_force, "gtc");
  assert.equal(again.id, "o-existing", "a duplicate client id returns the original order instead of a second one");
});
