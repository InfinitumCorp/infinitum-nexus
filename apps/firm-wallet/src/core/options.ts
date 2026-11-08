/**
 * Options on Derive: live option chains from Derive's free public API (v3), with Conjure's
 * chance of each strike finishing in the money next to the market's own price.
 *
 * Trading Derive options needs a Derive account (its own chain and session keys), so the wallet
 * opens the chosen instrument on Derive to trade, and shows the probabilities here first.
 * Use is subject to the venue's own terms.
 */
import { DERIVE_API, DERIVE_APP, type NetworkMode } from "./config.ts";

export interface OptionRow {
  instrument: string;
  kind: "call" | "put";
  strike: number;
  expiry: string; // ISO
  mark?: number;
  iv?: number;
  delta?: number;
  bid?: number;
  ask?: number;
}

async function pub<T>(mode: NetworkMode, method: string, params: unknown): Promise<T> {
  const res = await fetch(`${DERIVE_API[mode]}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
  const json = (await res.json().catch(() => ({}))) as { result?: T; error?: { message: string } };
  if (!res.ok || json.error || json.result === undefined) throw new Error(json.error?.message ?? `Derive is unavailable (${res.status}).`);
  return json.result;
}

/** Derive options expire at 08:00 UTC on the date in the name. */
const EXPIRY_HOUR_UTC = 8;

/**
 * Parse a Derive option name, e.g. "ETH-20261127-2500-C" or "ADA-20261127-0_15-P"
 * ("_" stands for the decimal point). Returns null for perps, spot and anything else.
 */
export function parseOptionName(name: string): Omit<OptionRow, "mark" | "iv" | "delta" | "bid" | "ask"> | null {
  const m = /^([A-Z0-9]+)-(\d{4})(\d{2})(\d{2})-(\d+(?:_\d+)?)-([CP])$/.exec(name);
  if (!m) return null;
  const strike = Number(m[5]!.replace("_", "."));
  const expiry = new Date(Date.UTC(Number(m[2]), Number(m[3]) - 1, Number(m[4]), EXPIRY_HOUR_UTC));
  if (!Number.isFinite(strike) || Number.isNaN(expiry.getTime())) return null;
  return { instrument: name, kind: m[6] === "C" ? "call" : "put", strike, expiry: expiry.toISOString() };
}

export async function optionChain(mode: NetworkMode, currency: "ETH" | "BTC" | "SOL", maxExpiries = 3, now = Date.now()): Promise<OptionRow[]> {
  const names = await pub<string[]>(mode, "get_all_live_instruments", {});
  const rows = names
    .filter((n) => n.startsWith(`${currency}-`))
    .map(parseOptionName)
    .filter((r): r is NonNullable<typeof r> => !!r && Date.parse(r.expiry) > now);
  const expiries = [...new Set(rows.map((r) => r.expiry))].sort().slice(0, maxExpiries);
  return rows.filter((r) => expiries.includes(r.expiry)).sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike || a.kind.localeCompare(b.kind));
}

/** Derive v3 ticker: short keys. b/a = best bid/ask price, M = mark, option_pricing.i = IV, .d = delta. */
export interface DeriveTicker {
  b?: string;
  a?: string;
  M?: string;
  option_pricing?: { i?: string; d?: string } | null;
}

export function parseTicker(row: OptionRow, t: DeriveTicker): OptionRow {
  const n = (v?: string) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  // A price of "0" means there is no bid or ask on the book.
  const quote = (v?: string) => { const x = n(v); return x ? x : undefined; };
  return { ...row, mark: n(t.M), bid: quote(t.b), ask: quote(t.a), iv: n(t.option_pricing?.i), delta: n(t.option_pricing?.d) };
}

export async function optionTicker(mode: NetworkMode, row: OptionRow): Promise<OptionRow> {
  return parseTicker(row, await pub<DeriveTicker>(mode, "get_ticker", { instrument_name: row.instrument }));
}

export function deriveTradeUrl(mode: NetworkMode, row: OptionRow): string {
  const [currency] = row.instrument.split("-");
  return `${DERIVE_APP[mode]}/options/${encodeURIComponent(currency!.toLowerCase())}?instrument=${encodeURIComponent(row.instrument)}`;
}
