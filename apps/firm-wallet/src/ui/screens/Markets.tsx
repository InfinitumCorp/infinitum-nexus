import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { conjureMarketSignal, perpView, swarmQuestion, DISCLAIMER, type MarketSignal } from "@infinitum/conjure/markets";
import { CONJURE_SWARM, VENUE_TERMS, type ChainKey } from "../../core/config.ts";
import { cryptoCandles, tokenCandles } from "../../core/market-data.ts";
import { discoverStocks } from "../../core/stocks.ts";
import { errorText, savePrefs, toast, useStore } from "../store.ts";
import { num, pct, Prob, Seg, usd, useAsync } from "../kit.tsx";
import { openSwap } from "./Swap.tsx";

/** Asks once, on this device, before tokenized stocks, perps and options are shown. No location checks. */
export function MarketsGate({ children }: { children: ComponentChildren }) {
  const { prefs } = useStore();
  const [ok, setOk] = useState(false);
  if (prefs.marketsAcknowledged) return <>{children}</>;
  return (
    <section class="card ink stack narrow">
      <p class="eyebrow">Before you continue</p>
      <h2>Stocks, perps and options</h2>
      <p class="small muted">These markets are run by independent venues, not by Infinitum. Each venue's terms say who may use it, and some exclude people in certain countries (for example US persons) or regions under sanctions. Perps and options are leveraged and can lose money fast.</p>
      <ul class="small">{VENUE_TERMS.map((v) => <li><a href={v.url} target="_blank" rel="noopener noreferrer">{v.name} terms</a></li>)}</ul>
      <label class="row small"><input type="checkbox" checked={ok} onChange={(e) => setOk((e.target as HTMLInputElement).checked)} /> I've read the venue terms and I'm allowed to use these markets.</label>
      <button class="btn solid block" disabled={!ok} onClick={() => savePrefs({ marketsAcknowledged: true })}>Continue</button>
    </section>
  );
}

type Asset = { id: string; label: string; kind: "crypto" | "wrapped" | "stock"; coin?: string; ticker?: string; mint?: string; swap?: { chain: ChainKey; symbol: string } };

const CRYPTO: Asset[] = [
  { id: "BTC", label: "Bitcoin", kind: "crypto", coin: "BTC", swap: { chain: "base", symbol: "cbBTC" } },
  { id: "ETH", label: "Ether", kind: "crypto", coin: "ETH", swap: { chain: "base", symbol: "ETH" } },
  { id: "SOL", label: "Solana", kind: "crypto", coin: "SOL", swap: { chain: "solana", symbol: "SOL" } },
];
const WRAPPED: Asset[] = [
  { id: "WBTC", label: "Wrapped Bitcoin (Ethereum)", kind: "wrapped", coin: "BTC", swap: { chain: "ethereum", symbol: "WBTC" } },
  { id: "cbBTC", label: "Coinbase Wrapped BTC (Base)", kind: "wrapped", coin: "BTC", swap: { chain: "base", symbol: "cbBTC" } },
  { id: "WETH", label: "Wrapped Ether (Base)", kind: "wrapped", coin: "ETH", swap: { chain: "base", symbol: "WETH" } },
  { id: "wSOL", label: "Wrapped SOL", kind: "wrapped", coin: "SOL", swap: { chain: "solana", symbol: "SOL" } },
];

const cache = new Map<string, MarketSignal>();

async function signalFor(a: Asset, horizon: number): Promise<MarketSignal> {
  const key = `${a.coin ?? a.mint}:${horizon}`;
  const hit = cache.get(key);
  if (hit && Date.now() - Date.parse(hit.asOf) < 15 * 60_000) return hit;
  const candles = a.kind === "stock" ? await tokenCandles(a.mint!) : await cryptoCandles(a.coin!);
  const s = conjureMarketSignal(a.kind === "stock" ? a.id : a.coin!, candles, { horizonDays: horizon });
  cache.set(key, s);
  return s;
}

export function MarketsScreen() {
  const { prefs } = useStore();
  const [group, setGroup] = useState<"crypto" | "wrapped" | "stock">("crypto");
  const [horizon, setHorizon] = useState(7);
  const [selected, setSelected] = useState<Asset>(CRYPTO[1]!);
  const stocks = useAsync(async () => (group === "stock" && prefs.marketsAcknowledged ? discoverStocks() : []), [group, prefs.marketsAcknowledged]);
  const stockAssets: Asset[] = (stocks.data ?? []).map((s) => ({ id: s.symbol, label: s.name, kind: "stock", ticker: s.underlying, mint: s.address, swap: { chain: "solana", symbol: s.symbol } }));
  const list = group === "crypto" ? CRYPTO : group === "wrapped" ? WRAPPED : stockAssets;
  const sig = useAsync(() => signalFor(selected, horizon), [selected.id, horizon]);

  const body = (
    <div class="grid two">
      <section class="card stack">
        <div class="row between wrapflex">
          <Seg value={group} options={[{ value: "crypto", label: "Crypto" }, { value: "wrapped", label: "Wrapped" }, { value: "stock", label: "Stocks" }]} onChange={(g) => { setGroup(g); if (g !== "stock") setSelected((g === "crypto" ? CRYPTO : WRAPPED)[0]!); }} />
          <Seg value={String(horizon)} options={[{ value: "1", label: "1 day" }, { value: "7", label: "7 days" }, { value: "30", label: "30 days" }]} onChange={(h) => setHorizon(Number(h))} />
        </div>
        {group === "stock" && stocks.loading && <p class="small muted">Loading tokenized stocks…</p>}
        {group === "stock" && stocks.error && <p class="small down">{stocks.error}</p>}
        <table class="list">
          <thead><tr><th>Asset</th><th class="r">Type</th></tr></thead>
          <tbody>
            {list.map((a) => (
              <tr style={{ cursor: "pointer" }} onClick={() => setSelected(a)} aria-selected={a.id === selected.id}>
                <td><b>{a.id === selected.id ? "▸ " : ""}{a.id}</b> <span class="muted small">{a.label}</span></td>
                <td class="r small muted">{a.kind === "stock" ? `Tracks ${a.ticker}` : a.kind}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {group === "wrapped" && <p class="small muted">Wrapped tokens track their underlying 1:1, so Conjure scores the underlying's price history.</p>}
      </section>
      <SignalCard asset={selected} sig={sig} />
    </div>
  );

  return (
    <div class="stack">
      <p class="eyebrow">Conjure™ Markets · on-device predictive model</p>
      <h1>Markets</h1>
      <p class="muted small">Conjure learns from up to a year of daily prices on this device (METATRON logistic model + damped trend), tests itself on the recent period it never saw, and only suggests a buy or sell when it beat the base rate there. Free: no model calls.</p>
      {group === "stock" ? <MarketsGate>{body}</MarketsGate> : body}
    </div>
  );
}

function SignalCard({ asset, sig }: { asset: Asset; sig: ReturnType<typeof useAsync<MarketSignal>> }) {
  const [swarm, setSwarm] = useState<string>("");
  if (sig.loading) return <section class="card"><p class="muted">Conjure is learning {asset.id}…</p></section>;
  if (sig.error || !sig.data) return <section class="card"><p class="down">{sig.error ?? "No signal."}</p></section>;
  const s = sig.data;
  const pv = perpView(s);
  const trade = (side: "buy" | "sell") => asset.swap && openSwap(side === "buy"
    ? { chain: asset.swap.chain, from: "USDC", to: asset.swap.symbol }
    : { chain: asset.swap.chain, from: asset.swap.symbol, to: "USDC" });
  return (
    <section class="card ink stack">
      <div class="row between"><h2>{asset.id}</h2><span class="muted">{usd(s.price)}</span></div>
      <div class={`signal ${s.action === "buy" ? "up" : s.action === "sell" ? "down" : ""}`}>{s.action === "no_edge" ? "No edge" : s.action}</div>
      <p class="small">{s.reason}</p>
      <div>
        <div class="row between small"><span>Chance higher in {s.horizonDays} days</span><b>{pct(s.probabilityUp)}</b></div>
        <Prob p={s.probabilityUp} />
      </div>
      <dl class="kv">
        <dt>Expected move</dt><dd class={s.expectedReturn >= 0 ? "up" : "down"}>{s.expectedReturn >= 0 ? "+" : ""}{pct(s.expectedReturn, 1)}</dd>
        <dt>80% range</dt><dd>{usd(s.range.low)} – {usd(s.range.high)}</dd>
        <dt>Confidence</dt><dd>{s.confidence}</dd>
        <dt>Backtest</dt><dd>{s.backtest.testSize} unseen days · skill {pct(s.backtest.skill, 1)} · hit rate {pct(s.backtest.hitRate)} · AUC {num(s.backtest.auc, 2)}</dd>
        <dt>Drivers</dt><dd>{s.factors.length ? s.factors.map((f) => `${f.label} ×${f.effect}`).join(" · ") : "—"}</dd>
        <dt>Perps view</dt><dd>{pv.direction === "flat" ? "Stay flat" : pv.direction} · leverage ceiling {pv.maxSensibleLeverage}×</dd>
      </dl>
      <div class="row wrapflex">
        <button class="btn solid" disabled={!asset.swap} onClick={() => trade("buy")}>Buy {asset.id}</button>
        <button class="btn" disabled={!asset.swap} onClick={() => trade("sell")}>Sell {asset.id}</button>
        {asset.coin && <a class="btn ghost" href={`#/perps?coin=${asset.coin}`}>Trade {asset.coin} perp</a>}
        {CONJURE_SWARM && <button class="btn ghost" onClick={async () => {
          try {
            const res = await fetch("/api/conjure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(swarmQuestion(s)) });
            const j = (await res.json()) as { id?: string; error?: string };
            if (!res.ok) throw new Error(j.error ?? "The swarm is unavailable.");
            setSwarm(`Swarm forecast started (${j.id}). It takes a few minutes.`);
          } catch (e) {
            toast(errorText(e), "err");
          }
        }}>Ask the @conjure swarm</button>}
      </div>
      {swarm && <p class="note">{swarm}</p>}
      <p class="small muted">{DISCLAIMER}</p>
    </section>
  );
}

