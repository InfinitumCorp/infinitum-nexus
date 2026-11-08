/**
 * Options on Derive (formerly Lyra): live option chains from Derive's free public API, with
 * Conjure's chance of each strike finishing in the money next to the market's own price.
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
  const res = await fetch(`${DERIVE_API[mode]}/public/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (!res.ok || json.error) throw new Error(json.error?.message ?? `Derive ${res.status}`);
  return json.result as T;
}

interface DeriveInstrument {
  instrument_name: string;
  is_active: boolean;
  option_details?: { strike: string; expiry: number; option_type: "C" | "P" };
}

export async function optionChain(mode: NetworkMode, currency: "ETH" | "BTC" | "SOL", maxExpiries = 3): Promise<OptionRow[]> {
  const list = await pub<DeriveInstrument[]>(mode, "get_instruments", { currency, instrument_type: "option", expired: false });
  const rows = list
    .filter((i) => i.is_active && i.option_details)
    .map((i) => ({
      instrument: i.instrument_name,
      kind: i.option_details!.option_type === "C" ? ("call" as const) : ("put" as const),
      strike: Number(i.option_details!.strike),
      expiry: new Date(i.option_details!.expiry * 1000).toISOString(),
    }));
  const expiries = [...new Set(rows.map((r) => r.expiry))].sort().slice(0, maxExpiries);
  return rows.filter((r) => expiries.includes(r.expiry)).sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike || a.kind.localeCompare(b.kind));
}

export async function optionTicker(mode: NetworkMode, row: OptionRow): Promise<OptionRow> {
  const t = await pub<{ mark_price?: string; best_bid_price?: string; best_ask_price?: string; option_pricing?: { iv?: string; delta?: string } }>(
    mode, "get_ticker", { instrument_name: row.instrument },
  );
  const n = (v?: string) => (v === undefined ? undefined : Number(v));
  return { ...row, mark: n(t.mark_price), bid: n(t.best_bid_price), ask: n(t.best_ask_price), iv: n(t.option_pricing?.iv), delta: n(t.option_pricing?.delta) };
}

export function deriveTradeUrl(mode: NetworkMode, row: OptionRow): string {
  const [currency] = row.instrument.split("-");
  return `${DERIVE_APP[mode]}/options/${encodeURIComponent(currency!.toLowerCase())}?instrument=${encodeURIComponent(row.instrument)}`;
}
