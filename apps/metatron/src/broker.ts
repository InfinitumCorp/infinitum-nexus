/**
 * Brokers METATRON can trade through. Alpaca is the first real integration (stocks, ETFs and
 * crypto, with separate paper and live endpoints). PaperBroker is an in-memory simulator used
 * for the practice portfolio and for tests.
 */
export type Side = "buy" | "sell";

export interface BrokerAccount {
  id: string;
  currency: string;
  cash: number;
  equity: number;
  buyingPower: number;
  /** Equity at the previous close; equity - lastEquity = today's P&L. */
  lastEquity: number;
  status: string;
  paper: boolean;
}

export interface BrokerPosition {
  symbol: string;
  qty: number;
  avgEntry: number;
  marketValue: number;
  currentPrice: number;
  unrealizedPl: number;
}

export interface OrderRequest {
  symbol: string;
  side: Side;
  /** Dollar amount for fractional market orders. */
  notionalUsd: number;
  /** Idempotency key: retrying with the same id never places a second order. */
  clientOrderId: string;
}

export interface BrokerOrder {
  id: string;
  clientOrderId: string;
  symbol: string;
  side: Side;
  status: string;
  notionalUsd: number;
  filledQty: number;
  filledAvgPrice: number | null;
  submittedAt: string;
}

export interface Broker {
  readonly name: string;
  readonly paper: boolean;
  account(): Promise<BrokerAccount>;
  positions(): Promise<BrokerPosition[]>;
  placeOrder(req: OrderRequest): Promise<BrokerOrder>;
  /** Percent change of each symbol over roughly the past month, for momentum strategies. */
  monthlyReturns?(symbols: string[]): Promise<Record<string, number>>;
  /** Latest trade price per symbol. */
  latestPrices?(symbols: string[]): Promise<Record<string, number>>;
}

export class BrokerError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const isCrypto = (s: string) => s.includes("/") || /^(BTC|ETH|SOL|LTC|AVAX|LINK|DOGE)USD$/.test(s);
const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v));

/* ------------------------------------------------------------------ */

export interface AlpacaConfig {
  keyId: string;
  secret: string;
  paper: boolean;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
}

export class AlpacaBroker implements Broker {
  readonly name = "alpaca";
  readonly paper: boolean;
  private readonly cfg: AlpacaConfig;
  private readonly fetch: typeof fetch;

  constructor(cfg: AlpacaConfig) {
    if (!cfg.keyId || !cfg.secret) throw new BrokerError("Alpaca key id and secret are required");
    this.cfg = cfg;
    this.paper = cfg.paper;
    this.fetch = cfg.fetchImpl ?? fetch;
  }

  private get base() {
    return this.paper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
  }

  private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(url, {
      ...init,
      headers: { "APCA-API-KEY-ID": this.cfg.keyId, "APCA-API-SECRET-KEY": this.cfg.secret, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new BrokerError(String(json.message ?? `Alpaca request failed (${res.status})`), res.status);
    return json as T;
  }

  async account(): Promise<BrokerAccount> {
    const a = await this.call<Record<string, unknown>>(this.base + "/v2/account");
    return {
      id: String(a.id), currency: String(a.currency ?? "USD"), cash: num(a.cash), equity: num(a.equity),
      buyingPower: num(a.buying_power), lastEquity: num(a.last_equity), status: String(a.status), paper: this.paper,
    };
  }

  async positions(): Promise<BrokerPosition[]> {
    const list = await this.call<Record<string, unknown>[]>(this.base + "/v2/positions");
    return list.map((p) => ({
      symbol: String(p.symbol), qty: num(p.qty), avgEntry: num(p.avg_entry_price), marketValue: num(p.market_value),
      currentPrice: num(p.current_price), unrealizedPl: num(p.unrealized_pl),
    }));
  }

  private toOrder(o: Record<string, unknown>): BrokerOrder {
    return {
      id: String(o.id), clientOrderId: String(o.client_order_id), symbol: String(o.symbol), side: o.side as Side,
      status: String(o.status), notionalUsd: num(o.notional), filledQty: num(o.filled_qty),
      filledAvgPrice: o.filled_avg_price == null ? null : num(o.filled_avg_price), submittedAt: String(o.submitted_at ?? ""),
    };
  }

  async placeOrder(req: OrderRequest): Promise<BrokerOrder> {
    const body = {
      symbol: req.symbol, side: req.side, type: "market",
      time_in_force: isCrypto(req.symbol) ? "gtc" : "day",
      notional: req.notionalUsd.toFixed(2), client_order_id: req.clientOrderId,
    };
    try {
      return this.toOrder(await this.call(this.base + "/v2/orders", { method: "POST", body: JSON.stringify(body) }));
    } catch (err) {
      // A retry after a timeout: the order may already exist under this client id.
      if (err instanceof BrokerError && err.status === 422 && /client_order_id/i.test(err.message)) {
        const existing = await this.call<Record<string, unknown>>(
          this.base + "/v2/orders:by_client_order_id?client_order_id=" + encodeURIComponent(req.clientOrderId),
        );
        return this.toOrder(existing);
      }
      throw err;
    }
  }

  async latestPrices(symbols: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const stocks = symbols.filter((s) => !isCrypto(s)), crypto = symbols.filter(isCrypto);
    if (stocks.length) {
      const r = await this.call<{ trades: Record<string, { p: number }> }>(
        `https://data.alpaca.markets/v2/stocks/trades/latest?symbols=${encodeURIComponent(stocks.join(","))}&feed=iex`,
      );
      for (const [s, t] of Object.entries(r.trades ?? {})) if (t?.p > 0) out[s] = t.p;
    }
    if (crypto.length) {
      const r = await this.call<{ trades: Record<string, { p: number }> }>(
        `https://data.alpaca.markets/v1beta3/crypto/us/latest/trades?symbols=${encodeURIComponent(crypto.join(","))}`,
      );
      for (const [s, t] of Object.entries(r.trades ?? {})) if (t?.p > 0) out[s] = t.p;
    }
    return out;
  }

  async monthlyReturns(symbols: string[]): Promise<Record<string, number>> {
    const now = this.cfg.clock?.() ?? new Date();
    const start = new Date(now.getTime() - 35 * 864e5).toISOString().slice(0, 10);
    const stocks = symbols.filter((s) => !isCrypto(s));
    const out: Record<string, number> = {};
    if (!stocks.length) return out;
    const r = await this.call<{ bars: Record<string, { c: number }[]> }>(
      `https://data.alpaca.markets/v2/stocks/bars?symbols=${encodeURIComponent(stocks.join(","))}&timeframe=1Day&start=${start}&adjustment=all&feed=iex&limit=1000`,
    );
    for (const s of stocks) {
      const bars = r.bars?.[s] ?? [];
      if (bars.length >= 2) out[s] = ((bars[bars.length - 1].c - bars[0].c) / bars[0].c) * 100;
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */

export interface PaperState {
  cash: number;
  lastEquity: number;
  positions: Record<string, { qty: number; avgEntry: number }>;
  orders: BrokerOrder[];
}

/** Fills instantly at the supplied price. State is a plain object so it can be persisted. */
export class PaperBroker implements Broker {
  readonly name = "paper";
  readonly paper = true;
  readonly state: PaperState;
  private readonly price: (symbol: string) => number;

  constructor(state: PaperState, price: (symbol: string) => number) {
    this.state = state;
    this.price = price;
  }

  static fresh(cash = 100_000): PaperState {
    return { cash, lastEquity: cash, positions: {}, orders: [] };
  }

  private equity() {
    return this.state.cash + Object.entries(this.state.positions).reduce((s, [k, p]) => s + p.qty * this.price(k), 0);
  }

  async account(): Promise<BrokerAccount> {
    const eq = this.equity();
    return { id: "paper", currency: "USD", cash: this.state.cash, equity: eq, buyingPower: this.state.cash, lastEquity: this.state.lastEquity, status: "ACTIVE", paper: true };
  }

  async positions(): Promise<BrokerPosition[]> {
    return Object.entries(this.state.positions).map(([symbol, p]) => {
      const px = this.price(symbol);
      return { symbol, qty: p.qty, avgEntry: p.avgEntry, marketValue: p.qty * px, currentPrice: px, unrealizedPl: p.qty * (px - p.avgEntry) };
    });
  }

  async placeOrder(req: OrderRequest): Promise<BrokerOrder> {
    const dup = this.state.orders.find((o) => o.clientOrderId === req.clientOrderId);
    if (dup) return dup;
    const px = this.price(req.symbol);
    if (!(px > 0)) throw new BrokerError(`No price for ${req.symbol}`);
    let qty: number, amount: number;
    if (req.side === "buy") {
      amount = Math.min(req.notionalUsd, this.state.cash);
      if (amount < 1) throw new BrokerError("Not enough cash");
      qty = amount / px;
      const cur = this.state.positions[req.symbol] ?? { qty: 0, avgEntry: 0 };
      const nq = cur.qty + qty;
      this.state.positions[req.symbol] = { qty: nq, avgEntry: (cur.qty * cur.avgEntry + amount) / nq };
      this.state.cash -= amount;
    } else {
      const cur = this.state.positions[req.symbol];
      if (!cur || cur.qty <= 0) throw new BrokerError(`No ${req.symbol} to sell`);
      qty = Math.min(cur.qty, req.notionalUsd / px);
      amount = qty * px;
      cur.qty -= qty;
      if (cur.qty < 1e-9) delete this.state.positions[req.symbol];
      this.state.cash += amount;
    }
    this.state.cash = Math.round(this.state.cash * 100) / 100;
    const order: BrokerOrder = {
      id: "paper-" + (this.state.orders.length + 1), clientOrderId: req.clientOrderId, symbol: req.symbol, side: req.side,
      status: "filled", notionalUsd: amount, filledQty: qty, filledAvgPrice: px, submittedAt: new Date().toISOString(),
    };
    this.state.orders.unshift(order);
    this.state.orders = this.state.orders.slice(0, 500);
    return order;
  }
}
