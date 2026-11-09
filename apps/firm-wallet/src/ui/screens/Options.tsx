import { useMemo, useState } from "preact/hooks";
import { conjureMarketSignal, optionView, DISCLAIMER } from "@infinitum/conjure/markets";
import { cryptoCandles } from "../../core/market-data.ts";
import { deriveTradeUrl, optionChain, optionTicker, type OptionRow } from "../../core/options.ts";
import { useStore } from "../store.ts";
import { num, pct, Seg, usd, useAsync } from "../kit.tsx";
import { MarketsGate } from "./Markets.tsx";

export function OptionsScreen() {
  return (
    <div class="stack">
      <p class="eyebrow">Options · Derive</p>
      <h1>Options</h1>
      <MarketsGate><Options /></MarketsGate>
    </div>
  );
}

function Options() {
  const { prefs } = useStore();
  const [currency, setCurrency] = useState<"ETH" | "BTC" | "SOL">("ETH");
  const [kind, setKind] = useState<"call" | "put">("call");
  const chain = useAsync(() => optionChain(prefs.mode, currency), [prefs.mode, currency]);
  const signal = useAsync(async () => conjureMarketSignal(currency, await cryptoCandles(currency), { horizonDays: 7 }), [currency]);
  const expiries = useMemo(() => [...new Set((chain.data ?? []).map((r) => r.expiry))], [chain.data]);
  const [expiry, setExpiry] = useState<string>("");
  const exp = expiry && expiries.includes(expiry) ? expiry : expiries[0] ?? "";
  const spot = signal.data?.price;
  const rows = useMemo(() => {
    const all = (chain.data ?? []).filter((r) => r.expiry === exp && r.kind === kind);
    if (!spot) return all.slice(0, 15);
    // The 15 strikes nearest the current price.
    return [...all].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, 15).sort((a, b) => a.strike - b.strike);
  }, [chain.data, exp, kind, spot]);
  const tickers = useAsync(() => Promise.all(rows.map((r) => optionTicker(prefs.mode, r).catch(() => r))), [rows.map((r) => r.instrument).join(",")]);

  return (
    <div class="stack">
      <div class="row wrapflex">
        <Seg value={currency} options={[{ value: "ETH", label: "ETH" }, { value: "BTC", label: "BTC" }, { value: "SOL", label: "SOL" }]} onChange={setCurrency} />
        <Seg value={kind} options={[{ value: "call", label: "Calls" }, { value: "put", label: "Puts" }]} onChange={setKind} />
        {expiries.length > 0 && <Seg value={exp} options={expiries.map((e) => ({ value: e, label: new Date(e).toLocaleDateString(undefined, { month: "short", day: "numeric" }) }))} onChange={setExpiry} />}
      </div>
      <p class="small muted">
        Spot {usd(spot)}. "Conjure ITM" is Conjure's chance the option finishes in the money, using its on-device model (or volatility alone when it has no proven edge). "Market ITM" is the chance implied by the option's own volatility. A big gap is worth a closer look, not a sure thing. Trades open on Derive, which needs its own account.
      </p>
      {chain.error && <p class="warn">{chain.error}</p>}
      {chain.loading && <p class="muted">Loading the option chain…</p>}
      {rows.length > 0 && (
        <div class="card scroll-x">
          <table class="list">
            <thead><tr><th>Strike</th><th class="r">Bid / ask</th><th class="r">IV</th><th class="r">Delta</th><th class="r">Market ITM</th><th class="r">Conjure ITM</th><th /></tr></thead>
            <tbody>
              {(tickers.data ?? rows).map((r: OptionRow) => {
                const v = signal.data ? optionView(signal.data, { kind: r.kind, strike: r.strike, expiry: new Date(r.expiry), iv: r.iv }) : null;
                return (
                  <tr>
                    <td><b>{num(r.strike)}</b></td>
                    <td class="r">{r.bid ? usd(r.bid) : "—"} / {r.ask ? usd(r.ask) : "—"}</td>
                    <td class="r">{r.iv ? pct(r.iv) : "—"}</td>
                    <td class="r">{r.delta !== undefined ? num(r.delta, 2) : "—"}</td>
                    <td class="r">{v?.marketItm !== undefined ? pct(v.marketItm) : "—"}</td>
                    <td class={`r ${v?.edge !== undefined && Math.abs(v.edge) >= 0.05 ? (v.edge > 0 ? "up" : "down") : ""}`}>{v ? pct(v.conjureItm) : "…"}</td>
                    <td class="r"><a class="btn ghost" href={deriveTradeUrl(prefs.mode, r)} target="_blank" rel="noopener noreferrer">Trade on Derive</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!chain.loading && !chain.error && rows.length === 0 && <p class="muted">No live options for {currency} on {prefs.mode === "mainnet" ? "Derive" : "Derive testnet"} right now.</p>}
      <p class="small muted">{DISCLAIMER}</p>
    </div>
  );
}
