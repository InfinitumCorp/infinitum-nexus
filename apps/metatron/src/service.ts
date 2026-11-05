/**
 * MetatronService: the money side of METATRON.
 *
 * - Links banks, cards, loans and brokerages through Plaid (read access), keeps balances
 *   and transactions in sync, and lets the person revoke any connection.
 * - Connects a broker (Alpaca) for trading, plus a paper portfolio for practice.
 * - Every order, from the person, an agent or the assistant, passes guardrails, waits in an
 *   approval queue (paper agents may skip the queue if allowed), is re-checked at execution
 *   and is sent with an idempotency key.
 * - Grants, revocations, proposals, approvals, orders and policy changes are signed onto
 *   the Firmament ledger.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Ledger, Signer, RecordType } from "@infinitum/firmament";
import { Vault } from "./vault.ts";
import { PlaidClient, PlaidError } from "./plaid.ts";
import { AlpacaBroker, BrokerError, PaperBroker, type Broker, type BrokerPosition } from "./broker.ts";
import { DEFAULT_POLICY, checkOrder, normalizePolicy, type OrderIntent, type Origin, type Policy } from "./guardrails.ts";
import { DEFAULT_AGENTS, planDca, planMomentum, planRebalance, type AgentConfig } from "./agents.ts";
import type { AccountRef, Approval, Connection, OrderResult, StoredTxn, UserRecord, UserStore } from "./store.ts";

export class MetatronError extends Error {
  readonly status: number;
  readonly reasons?: string[];
  constructor(message: string, status = 400, reasons?: string[]) {
    super(message);
    this.status = status;
    this.reasons = reasons;
  }
}

export interface MetatronConfig {
  store: UserStore;
  ledger: Ledger;
  signer: Signer;
  vault: Vault;
  /** Optional: without it, bank linking is reported as not configured. */
  plaid?: PlaidClient;
  /** Builds a broker from stored credentials. Overridable for tests. */
  brokerFactory?: (cfg: { keyId: string; secret: string; paper: boolean }) => Broker;
  /** Prices for the paper portfolio when the person has no broker connected. */
  priceFeed?: (symbols: string[]) => Promise<Record<string, number>>;
  clock?: () => Date;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const LINK_CODE_TTL_MS = 10 * 60_000;

export class MetatronService {
  private readonly cfg: MetatronConfig;
  private readonly linkCodes = new Map<string, { cid: string; exp: number; exchanged: boolean }>();
  private readonly prices = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(cfg: MetatronConfig) {
    this.cfg = cfg;
  }

  private now() {
    return this.cfg.clock?.() ?? new Date();
  }
  private today() {
    return this.now().toISOString().slice(0, 10);
  }

  private record(type: RecordType, actor: string, subject: string, payload: Record<string, unknown>) {
    return this.cfg.ledger.append({ type, product: "metatron", actor, subject, payload }, this.cfg.signer);
  }

  /** Runs one change per person at a time, so concurrent approvals can't double-spend. */
  private async withUser<T>(cid: string, fn: (u: UserRecord) => Promise<T>): Promise<T> {
    const prev = this.locks.get(cid) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const u = await this.load(cid);
      const out = await fn(u);
      await this.cfg.store.put(u);
      return out;
    });
    this.locks.set(cid, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(cid) === run) this.locks.delete(cid);
    }
  }

  private async load(cid: string): Promise<UserRecord> {
    const u = await this.cfg.store.get(cid);
    if (u) return u;
    return { cid, connections: [], txns: [], paper: PaperBroker.fresh(), policy: { ...DEFAULT_POLICY }, agents: structuredClone(DEFAULT_AGENTS), approvals: [], orderLog: [] };
  }

  private plaid(): PlaidClient {
    if (!this.cfg.plaid) throw new MetatronError("Bank linking isn't configured on this server (set PLAID_CLIENT_ID and PLAID_SECRET).", 503);
    return this.cfg.plaid;
  }

  private accessToken(u: UserRecord, c: Connection) {
    return this.cfg.vault.open(c.sealed, `${u.cid}|${c.id}`);
  }

  /* ======================= Bank linking (Plaid) ======================= */

  /** A short-lived, single-use code that lets the hosted Link page act for this person without a password or session token in the URL. */
  createLinkCode(cid: string) {
    const code = randomBytes(24).toString("base64url");
    this.linkCodes.set(code, { cid, exp: Date.now() + LINK_CODE_TTL_MS, exchanged: false });
    for (const [k, v] of this.linkCodes) if (v.exp < Date.now()) this.linkCodes.delete(k);
    return { code, expiresInSeconds: LINK_CODE_TTL_MS / 1000 };
  }

  private redeem(code: string) {
    const c = this.linkCodes.get(code);
    if (!c || c.exp < Date.now() || c.exchanged) throw new MetatronError("This link session has expired. Start again from METATRON.", 401);
    return c;
  }

  async linkToken(code: string, opts: { investments?: boolean } = {}) {
    const c = this.redeem(code);
    const r = await this.plaid().createLinkToken(c.cid, opts);
    return { linkToken: r.link_token, expiration: r.expiration };
  }

  async exchange(code: string, publicToken: string, institution: string) {
    const c = this.redeem(code);
    c.exchanged = true;
    const { access_token, item_id } = await this.plaid().exchangePublicToken(publicToken);
    const conn = await this.withUser(c.cid, async (u) => {
      const id = "conn_" + randomUUID();
      const conn: Connection = {
        id, itemId: item_id, institution: String(institution || "Bank").slice(0, 80),
        sealed: this.cfg.vault.seal(access_token, `${u.cid}|${id}`), cursor: "", createdAt: this.now().toISOString(), status: "ok",
      };
      u.connections.push(conn);
      await this.record("grant", u.cid, id, { provider: "plaid", institution: conn.institution, scopes: ["balances", "transactions"], env: this.plaid().env });
      return conn;
    });
    await this.sync(c.cid, conn.id).catch(() => {});
    return this.publicConnection(conn);
  }

  private publicConnection(c: Connection) {
    return { id: c.id, institution: c.institution, status: c.status, createdAt: c.createdAt, lastSyncAt: c.lastSyncAt ?? null };
  }

  async connections(cid: string) {
    return (await this.load(cid)).connections.map((c) => this.publicConnection(c));
  }

  /** Live balances from every connection. A connection that needs the person to sign in again is reported, not fatal. */
  async accounts(cid: string) {
    const u = await this.load(cid);
    const out: Record<string, unknown>[] = [];
    const issues: { connectionId: string; institution: string; problem: string }[] = [];
    let changed = false;
    for (const c of u.connections) {
      try {
        const accts = await this.plaid().getBalances(this.accessToken(u, c));
        for (const a of accts) out.push({
          connectionId: c.id, institution: c.institution, accountId: a.account_id, name: a.name, mask: a.mask ?? null,
          type: a.type, subtype: a.subtype ?? null, current: a.balances.current, available: a.balances.available,
          limit: a.balances.limit, currency: a.balances.iso_currency_code,
        });
        if (c.status !== "ok") { c.status = "ok"; changed = true; }
      } catch (err) {
        const login = err instanceof PlaidError && err.code === "ITEM_LOGIN_REQUIRED";
        issues.push({ connectionId: c.id, institution: c.institution, problem: login ? "Sign in to your bank again to keep this connection working." : "Couldn't reach this institution. Try again later." });
        const st = login ? "login_required" : "error";
        if (c.status !== st) { c.status = st; changed = true; }
      }
    }
    if (changed) await this.withUser(cid, async (w) => { for (const c of w.connections) { const m = u.connections.find((x) => x.id === c.id); if (m) c.status = m.status; } });
    return { accounts: out, issues };
  }

  async sync(cid: string, connectionId?: string) {
    return this.withUser(cid, async (u) => {
      let added = 0, modified = 0, removed = 0;
      for (const c of u.connections.filter((x) => !connectionId || x.id === connectionId)) {
        const r = await this.plaid().syncTransactions(this.accessToken(u, c), c.cursor || undefined);
        const toTxn = (t: (typeof r.added)[number]): StoredTxn => ({
          id: t.transaction_id, connectionId: c.id, accountId: t.account_id, date: t.date, name: t.merchant_name || t.name,
          amount: t.amount, currency: t.iso_currency_code, pending: t.pending, category: t.personal_finance_category?.primary ?? null,
        });
        const gone = new Set(r.removed.map((x) => x.transaction_id));
        const mod = new Map(r.modified.map((t) => [t.transaction_id, toTxn(t)]));
        u.txns = u.txns.filter((t) => !gone.has(t.id)).map((t) => mod.get(t.id) ?? t);
        const known = new Set(u.txns.map((t) => t.id));
        u.txns.unshift(...r.added.map(toTxn).filter((t) => !known.has(t.id)));
        u.txns.sort((a, b) => (a.date < b.date ? 1 : -1));
        u.txns = u.txns.slice(0, 5000);
        c.cursor = r.nextCursor;
        c.lastSyncAt = this.now().toISOString();
        added += r.added.length; modified += r.modified.length; removed += r.removed.length;
      }
      return { added, modified, removed };
    });
  }

  async transactions(cid: string, limit = 200) {
    return (await this.load(cid)).txns.slice(0, Math.min(1000, Math.max(1, limit)));
  }

  async removeConnection(cid: string, connectionId: string) {
    return this.withUser(cid, async (u) => {
      const c = u.connections.find((x) => x.id === connectionId);
      if (!c) throw new MetatronError("Connection not found", 404);
      await this.plaid().removeItem(this.accessToken(u, c)).catch(() => {}); // revoke at Plaid; remove locally either way
      u.connections = u.connections.filter((x) => x.id !== connectionId);
      u.txns = u.txns.filter((t) => t.connectionId !== connectionId);
      await this.record("revoke", u.cid, connectionId, { provider: "plaid", institution: c.institution });
      return { removed: true };
    });
  }

  /** Plaid webhook. Returns false if the signature doesn't check out. */
  async webhook(rawBody: string, verification: string | undefined) {
    if (!(await this.plaid().verifyWebhook(rawBody, verification))) return false;
    const body = JSON.parse(rawBody) as { webhook_type?: string; webhook_code?: string; item_id?: string };
    if (!body.item_id) return true;
    const u = await this.cfg.store.findByItem(body.item_id);
    if (!u) return true;
    const c = u.connections.find((x) => x.itemId === body.item_id)!;
    if (body.webhook_type === "TRANSACTIONS" && body.webhook_code === "SYNC_UPDATES_AVAILABLE") await this.sync(u.cid, c.id);
    if (body.webhook_type === "ITEM" && (body.webhook_code === "ERROR" || body.webhook_code === "PENDING_EXPIRATION")) {
      await this.withUser(u.cid, async (w) => { const x = w.connections.find((y) => y.id === c.id); if (x) x.status = "login_required"; });
    }
    return true;
  }

  /* ======================= Broker ======================= */

  async connectBroker(cid: string, input: { keyId: string; secret: string; paper: boolean }) {
    const paper = input.paper !== false;
    const broker = this.makeBroker({ keyId: String(input.keyId || ""), secret: String(input.secret || ""), paper });
    const acct = await broker.account().catch((err) => {
      throw new MetatronError(err instanceof BrokerError && (err.status === 401 || err.status === 403) ? "Alpaca rejected those keys." : "Couldn't reach Alpaca to check the keys.", 400);
    });
    return this.withUser(cid, async (u) => {
      u.broker = { provider: "alpaca", paper, sealed: this.cfg.vault.seal(JSON.stringify({ keyId: input.keyId, secret: input.secret }), `${u.cid}|broker`), addedAt: this.now().toISOString() };
      await this.record("grant", u.cid, "broker", { provider: "alpaca", paper, scopes: ["account", "positions", "orders"] });
      return { provider: "alpaca", paper, status: acct.status, equity: acct.equity };
    });
  }

  async disconnectBroker(cid: string) {
    return this.withUser(cid, async (u) => {
      if (!u.broker) return { removed: false };
      const paper = u.broker.paper;
      delete u.broker;
      for (const a of u.agents) if (a.account === "broker") a.enabled = false;
      await this.record("revoke", u.cid, "broker", { provider: "alpaca", paper });
      return { removed: true };
    });
  }

  private makeBroker(c: { keyId: string; secret: string; paper: boolean }): Broker {
    return this.cfg.brokerFactory ? this.cfg.brokerFactory(c) : new AlpacaBroker(c);
  }

  private realBroker(u: UserRecord): Broker | null {
    if (!u.broker) return null;
    const { keyId, secret } = JSON.parse(this.cfg.vault.open(u.broker.sealed, `${u.cid}|broker`));
    return this.makeBroker({ keyId, secret, paper: u.broker.paper });
  }

  private async refreshPrices(u: UserRecord, symbols: string[]) {
    const want = [...new Set(symbols)];
    if (!want.length) return;
    const real = this.realBroker(u);
    let got: Record<string, number> = {};
    try {
      if (real?.latestPrices) got = await real.latestPrices(want);
      else if (this.cfg.priceFeed) got = await this.cfg.priceFeed(want);
    } catch { /* fall back to the last known prices */ }
    for (const [s, p] of Object.entries(got)) if (p > 0) this.prices.set(s, p);
  }

  private broker(u: UserRecord, account: AccountRef): Broker {
    if (account === "paper") return new PaperBroker(u.paper, (s) => this.prices.get(s) ?? 0);
    const b = this.realBroker(u);
    if (!b) throw new MetatronError("Connect a broker first.", 409);
    return b;
  }

  async portfolio(cid: string, account: AccountRef) {
    const u = await this.load(cid);
    if (account === "paper") await this.refreshPrices(u, Object.keys(u.paper.positions));
    const b = this.broker(u, account);
    const [acct, positions] = await Promise.all([b.account(), b.positions()]);
    return { account: { ...acct, dayPl: r2(acct.equity - acct.lastEquity) }, positions };
  }

  /* ======================= Orders, guardrails, approvals ======================= */

  async policy(cid: string) {
    return (await this.load(cid)).policy;
  }

  async setPolicy(cid: string, patch: Partial<Policy>) {
    return this.withUser(cid, async (u) => {
      const before = u.policy;
      u.policy = normalizePolicy(patch, before);
      await this.record("audit", u.cid, "policy", { event: "policy_changed", before, after: u.policy });
      return u.policy;
    });
  }

  private ordersToday(u: UserRecord) {
    return u.orderLog.filter((o) => o.day === this.today()).length;
  }

  /** Checks a set of orders in sequence, as if earlier ones in the set had already filled. */
  private async vet(u: UserRecord, account: AccountRef, orders: OrderIntent[], origin: Origin) {
    if (account === "paper") await this.refreshPrices(u, orders.map((o) => o.symbol).concat(Object.keys(u.paper.positions)));
    const b = this.broker(u, account);
    const [acct, positions] = await Promise.all([b.account(), b.positions()]);
    const held = new Map<string, number>(positions.map((p: BrokerPosition) => [p.symbol, p.marketValue]));
    let bp = acct.buyingPower, count = this.ordersToday(u);
    const reasons: string[] = [];
    for (const o of orders) {
      const g = checkOrder(o, origin, { ordersToday: count, dayPlUsd: acct.equity - acct.lastEquity, buyingPower: bp, heldUsd: held.get(o.symbol) ?? 0 }, u.policy);
      if (!g.ok) reasons.push(...g.reasons.map((r) => `${o.side} ${o.symbol}: ${r}`));
      count++;
      if (o.side === "buy") bp -= o.notionalUsd; else bp += Math.min(o.notionalUsd, held.get(o.symbol) ?? 0);
    }
    return { reasons, broker: b };
  }

  private sanitize(orders: OrderIntent[]): OrderIntent[] {
    if (!Array.isArray(orders) || !orders.length || orders.length > 20) throw new MetatronError("Send between 1 and 20 orders.");
    return orders.map((o) => ({ symbol: String(o.symbol || "").trim().toUpperCase(), side: o.side === "sell" ? "sell" : "buy", notionalUsd: r2(Number(o.notionalUsd)) }));
  }

  /**
   * Proposes orders. They're checked now, then wait for approval. Paper orders from an agent
   * allowed to trade paper on its own are executed straight away.
   */
  async propose(cid: string, input: { account: AccountRef; orders: OrderIntent[]; origin: Origin; agentId?: string; note?: string; autoPaper?: boolean }) {
    const orders = this.sanitize(input.orders);
    const account: AccountRef = input.account === "paper" ? "paper" : "broker";
    return this.withUser(cid, async (u) => {
      const { reasons } = await this.vet(u, account, orders, input.origin);
      if (reasons.length) throw new MetatronError("Blocked by your guardrails", 422, reasons);
      const now = this.now();
      const a: Approval = {
        id: "apv_" + randomUUID(), origin: input.origin, agentId: input.agentId, account, orders,
        note: String(input.note ?? "").slice(0, 500), status: "pending", createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + u.policy.approvalTtlMinutes * 60_000).toISOString(),
      };
      u.approvals.unshift(a);
      u.approvals = u.approvals.slice(0, 500);
      await this.record("audit", u.cid, a.id, { event: "proposed", origin: a.origin, agentId: a.agentId ?? null, account, orders, paper: account === "paper" || !!u.broker?.paper });
      if (account === "paper" && input.autoPaper && input.origin === "agent") await this.execute(u, a, u.cid);
      return a;
    });
  }

  async approvals(cid: string, status?: Approval["status"]) {
    return this.withUser(cid, async (u) => {
      this.expire(u);
      return status ? u.approvals.filter((a) => a.status === status) : u.approvals.slice(0, 100);
    });
  }

  private expire(u: UserRecord) {
    const now = this.now().toISOString();
    for (const a of u.approvals) if (a.status === "pending" && a.expiresAt < now) a.status = "expired";
  }

  async decide(cid: string, approvalId: string, decision: "approve" | "decline") {
    return this.withUser(cid, async (u) => {
      this.expire(u);
      const a = u.approvals.find((x) => x.id === approvalId);
      if (!a) throw new MetatronError("Approval not found", 404);
      if (a.status !== "pending") throw new MetatronError(`This request is already ${a.status}.`, 409);
      a.decidedAt = this.now().toISOString();
      if (decision === "decline") {
        a.status = "declined";
        await this.record("audit", u.cid, a.id, { event: "declined" });
        return a;
      }
      await this.record("audit", u.cid, a.id, { event: "approved" });
      await this.execute(u, a, u.cid);
      return a;
    });
  }

  /** Re-checks guardrails, then sends each order with an idempotency key. */
  private async execute(u: UserRecord, a: Approval, actor: string) {
    const { reasons, broker } = await this.vet(u, a.account, a.orders, a.origin);
    if (reasons.length) {
      a.status = "failed";
      a.results = a.orders.map((o, i) => ({ ...o, ok: false, clientOrderId: `${a.id}-${i}`, error: "Guardrails changed before execution: " + reasons.join("; ") }));
      await this.record("audit", actor, a.id, { event: "blocked_at_execution", reasons });
      return;
    }
    const results: OrderResult[] = [];
    for (let i = 0; i < a.orders.length; i++) {
      const o = a.orders[i], clientOrderId = `${a.id}-${i}`;
      try {
        const r = await broker.placeOrder({ ...o, clientOrderId });
        results.push({ ...o, ok: true, clientOrderId, brokerOrderId: r.id, status: r.status, filledAvgPrice: r.filledAvgPrice });
        u.orderLog.unshift({ at: this.now().toISOString(), day: this.today(), account: a.account, clientOrderId, symbol: o.symbol, side: o.side, notionalUsd: o.notionalUsd, origin: a.origin });
        await this.record("payment", actor, clientOrderId, { kind: "order", origin: a.origin, agentId: a.agentId ?? null, broker: broker.name, paper: broker.paper, symbol: o.symbol, side: o.side, notionalUsd: o.notionalUsd, brokerOrderId: r.id, status: r.status, approval: a.id });
      } catch (err) {
        results.push({ ...o, ok: false, clientOrderId, error: (err as Error).message });
        await this.record("audit", actor, clientOrderId, { event: "order_failed", symbol: o.symbol, side: o.side, error: (err as Error).message });
      }
    }
    u.orderLog = u.orderLog.slice(0, 2000);
    a.results = results;
    const ok = results.filter((r) => r.ok).length;
    a.status = ok === results.length ? "executed" : ok ? "partial" : "failed";
  }

  /* ======================= Agents ======================= */

  async agents(cid: string) {
    return (await this.load(cid)).agents;
  }

  async updateAgent(cid: string, id: string, patch: Partial<AgentConfig>) {
    return this.withUser(cid, async (u) => {
      const a = u.agents.find((x) => x.id === id);
      if (!a) throw new MetatronError("Agent not found", 404);
      if (typeof patch.enabled === "boolean") a.enabled = patch.enabled;
      if (typeof patch.autoPaper === "boolean") a.autoPaper = patch.autoPaper;
      if (patch.account === "paper" || patch.account === "broker") a.account = patch.account;
      if (patch.targets && typeof patch.targets === "object") a.targets = Object.fromEntries(Object.entries(patch.targets).filter(([, w]) => Number(w) > 0).map(([s, w]) => [s.toUpperCase(), Number(w)]));
      if (Array.isArray(patch.universe)) a.universe = patch.universe.map((s) => String(s).toUpperCase()).slice(0, 30);
      if (Number(patch.holdCount) > 0) a.holdCount = Math.round(Number(patch.holdCount));
      if (patch.symbol) a.symbol = String(patch.symbol).toUpperCase();
      if (Number(patch.amountUsd) > 0) a.amountUsd = r2(Number(patch.amountUsd));
      await this.record("audit", u.cid, `agent:${id}`, { event: "agent_updated", agent: a });
      return a;
    });
  }

  /** Plans with the agent's strategy, then proposes through the normal guardrails and approvals. */
  async runAgent(cid: string, id: string) {
    const u = await this.load(cid);
    const a = u.agents.find((x) => x.id === id);
    if (!a) throw new MetatronError("Agent not found", 404);
    if (!a.enabled) throw new MetatronError(`${a.name} is turned off.`, 409);
    if (u.policy.killSwitch) throw new MetatronError("The kill switch is on.", 409);
    const symbols = [...Object.keys(a.targets ?? {}), ...(a.universe ?? []), ...(a.symbol ? [a.symbol] : [])];
    if (a.account === "paper") await this.refreshPrices(u, symbols.concat(Object.keys(u.paper.positions)));
    const b = this.broker(u, a.account);
    const [acct, positions] = await Promise.all([b.account(), b.positions()]);
    let plan;
    if (a.kind === "rebalance") plan = planRebalance(a, positions, acct.cash);
    else if (a.kind === "dca") plan = planDca(a);
    else {
      const source = this.realBroker(u);
      const returns = source?.monthlyReturns ? await source.monthlyReturns(a.universe ?? []).catch(() => ({})) : {};
      plan = planMomentum(a, positions, acct.cash, returns);
    }
    // Agents work inside the limits: cap each order and stop at the daily count, and say so.
    const left = Math.max(0, u.policy.maxDailyOrders - this.ordersToday(u));
    const clipped: string[] = [];
    const orders = plan.orders.slice(0, left).map((o) => {
      if (o.notionalUsd <= u.policy.maxOrderUsd) return o;
      clipped.push(`${o.symbol} capped at $${u.policy.maxOrderUsd}`);
      return { ...o, notionalUsd: u.policy.maxOrderUsd };
    });
    if (plan.orders.length > left) clipped.push(`${plan.orders.length - left} order(s) left for another day (daily limit)`);
    const note = plan.note + (clipped.length ? " Guardrails: " + clipped.join("; ") + "." : "");
    if (!orders.length) return { proposed: null, note: (plan.orders.length ? "" : "No trades needed. ") + note };
    const approval = await this.propose(cid, { account: a.account, orders, origin: "agent", agentId: a.id, note, autoPaper: a.account === "paper" && a.autoPaper });
    return { proposed: approval, note };
  }

  /* ======================= Ledger ======================= */

  /** This person's METATRON records. Every record is written with the owner's CID as actor. */
  async ledgerFor(cid: string, limit = 100) {
    const mine = await this.cfg.ledger.query({ product: "metatron", actor: cid });
    return mine.slice(-Math.min(500, Math.max(1, limit)));
  }

  verifyLedger() {
    return this.cfg.ledger.verify();
  }
}
