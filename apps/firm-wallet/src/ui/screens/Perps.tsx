import { useMemo, useState } from "preact/hooks";
import { conjureMarketSignal, perpView } from "@infinitum/conjure/markets";
import { HYPERLIQUID_BRIDGE, tokensFor } from "../../core/config.ts";
import { prepareDeposit } from "../../core/evm.ts";
import { cryptoCandles } from "../../core/market-data.ts";
import { MAX_WALLET_LEVERAGE, perpAccount, perpMarkets, prepareCancel, prepareClose, preparePerpOrder, type PerpMarket } from "../../core/perps.ts";
import { errorText, toast, useStore } from "../store.ts";
import { approveAndSend, approveAndSubmitPerp, Field, num, pct, Seg, usd, useAsync } from "../kit.tsx";
import { MarketsGate } from "./Markets.tsx";

export function PerpsScreen() {
  return (
    <div class="stack">
      <p class="eyebrow">Perpetual futures · Hyperliquid</p>
      <h1>Perps</h1>
      <MarketsGate><Perps /></MarketsGate>
    </div>
  );
}

function Perps() {
  const { session, prefs } = useStore();
  const mode = prefs.mode;
  const initialCoin = new URLSearchParams(location.hash.split("?")[1] ?? "").get("coin") ?? "BTC";
  const markets = useAsync(() => perpMarkets(mode), [mode]);
  const account = useAsync(() => perpAccount(mode, session!.evm.address), [mode, session?.evm.address]);
  const [coin, setCoin] = useState(initialCoin);
  const [query, setQuery] = useState("");
  const market = markets.data?.find((m) => m.name === coin);

  const filtered = useMemo(() => (markets.data ?? []).filter((m) => m.name.toLowerCase().includes(query.toLowerCase())).slice(0, 40), [markets.data, query]);

  return (
    <div class="grid two">
      <div class="stack">
        <section class="card stack">
          <div class="row between"><h3>Account</h3><button class="btn ghost" onClick={account.reload}>Refresh</button></div>
          {account.error && <p class="small down">{account.error}</p>}
          {account.data && (
            <dl class="kv">
              <dt>Account value</dt><dd>{usd(account.data.accountValue)}</dd>
              <dt>Withdrawable</dt><dd>{usd(account.data.withdrawable)}</dd>
              <dt>Margin used</dt><dd>{usd(account.data.marginUsed)}</dd>
            </dl>
          )}
          <Deposit onDone={account.reload} />
        </section>
        <section class="card stack">
          <h3>Markets</h3>
          <Field label="Search"><input value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} placeholder="BTC, ETH, SOL…" /></Field>
          {markets.loading && <p class="small muted">Loading markets…</p>}
          {markets.error && <p class="small down">{markets.error}</p>}
          <div class="scroll-x"><table class="list">
            <thead><tr><th>Market</th><th class="r">Price</th><th class="r">Max lev.</th></tr></thead>
            <tbody>{filtered.map((m) => (
              <tr style={{ cursor: "pointer" }} onClick={() => setCoin(m.name)}>
                <td><b>{m.name === coin ? "▸ " : ""}{m.name}</b>-PERP</td><td class="r">{m.mid ? usd(m.mid) : "—"}</td><td class="r">{m.maxLeverage}×</td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      </div>
      <div class="stack">
        {market ? <OrderTicket market={market} onDone={account.reload} /> : <section class="card"><p class="muted">Pick a market.</p></section>}
        {market && <ConjurePerp coin={market.name} />}
        <Positions account={account.data} markets={markets.data ?? []} onDone={account.reload} />
      </div>
    </div>
  );
}

export function Deposit({ onDone }: { onDone: () => void }) {
  const { session, prefs } = useStore();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  if (prefs.mode === "testnet") {
    return <p class="note">Testnet: get free test USDC from the Hyperliquid testnet faucet (app.hyperliquid-testnet.xyz/drip), using this wallet's address.</p>;
  }
  const usdc = tokensFor(prefs.mode, "arbitrum").find((t) => t.symbol === "USDC")!;
  return (
    <div class="stack">
      <p class="small muted">Fund perps by sending USDC on Arbitrum to Hyperliquid's bridge (minimum 5 USDC; less is lost). It arrives in about a minute. You also need a little ETH on Arbitrum for the network fee.</p>
      <div class="row">
        <input class="field" style={{ flex: 1, minHeight: 42, border: "1px solid var(--line)", padding: "0 12px" }} inputMode="decimal" placeholder="USDC amount" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value.replace(",", "."))} />
        <button class="btn" disabled={busy || !(Number(amount) >= 5)} onClick={async () => {
          setBusy(true);
          try {
            await approveAndSend([await prepareDeposit("mainnet", "arbitrum", session!.evm.address, usdc, HYPERLIQUID_BRIDGE.mainnet, amount, "Deposit USDC to Hyperliquid")]);
            toast("Deposit sent. It shows up in about a minute.");
            setAmount("");
            setTimeout(onDone, 60_000);
          } catch (e) {
            if (errorText(e) !== "Cancelled.") toast(errorText(e), "err");
          } finally {
            setBusy(false);
          }
        }}>Deposit</button>
      </div>
    </div>
  );
}

function OrderTicket({ market, onDone }: { market: PerpMarket; onDone: () => void }) {
  const { prefs } = useStore();
  const cap = Math.min(market.maxLeverage, MAX_WALLET_LEVERAGE);
  const [side, setSide] = useState<"long" | "short">("long");
  const [type, setType] = useState<"market" | "limit">("market");
  const [size, setSize] = useState("");
  const [lev, setLev] = useState(2);
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <section class="card ink stack">
      <div class="row between"><h2>{market.name}-PERP</h2><span class="muted">{usd(market.mid)}</span></div>
      <Seg value={side} options={[{ value: "long", label: "Long" }, { value: "short", label: "Short" }]} onChange={setSide} />
      <Seg value={type} options={[{ value: "market", label: "Market" }, { value: "limit", label: "Limit" }]} onChange={setType} />
      <Field label="Size (USD)"><input inputMode="decimal" value={size} onInput={(e) => setSize((e.target as HTMLInputElement).value.replace(",", "."))} placeholder="Minimum $10" /></Field>
      {type === "limit" && <Field label="Limit price"><input inputMode="decimal" value={limit} onInput={(e) => setLimit((e.target as HTMLInputElement).value.replace(",", "."))} /></Field>}
      <Field label={`Leverage: ${lev}×`} hint={`Wallet cap ${cap}×. Margin ≈ ${usd((Number(size) || 0) / lev)}.`}>
        <input type="range" min={1} max={cap} step={1} value={lev} onInput={(e) => setLev(Number((e.target as HTMLInputElement).value))} />
      </Field>
      <button class={`btn block ${side === "long" ? "solid" : "danger"}`} disabled={busy || !(Number(size) >= 10) || (type === "limit" && !(Number(limit) > 0))} onClick={async () => {
        setBusy(true);
        try {
          const order = preparePerpOrder({ market, side, usd: Number(size), leverage: lev, limitPx: type === "limit" ? Number(limit) : undefined });
          await approveAndSubmitPerp(prefs.mode, order);
          toast(type === "limit" ? "Order placed." : "Order filled.");
          onDone();
        } catch (e) {
          if (errorText(e) !== "Cancelled.") toast(errorText(e), "err");
        } finally {
          setBusy(false);
        }
      }}>{busy ? "Working…" : `Review ${side}`}</button>
      <p class="small muted">Hyperliquid sets fees and funding. Infinitum adds nothing. Leveraged trading can lose your whole margin.</p>
    </section>
  );
}

function ConjurePerp({ coin }: { coin: string }) {
  const sig = useAsync(async () => conjureMarketSignal(coin, await cryptoCandles(coin), { horizonDays: 7 }), [coin]);
  if (sig.loading) return <section class="card"><p class="small muted">Conjure is reading {coin}…</p></section>;
  if (sig.error || !sig.data) return <section class="card"><p class="small muted">Conjure: {sig.error ?? "no signal"}</p></section>;
  const v = perpView(sig.data);
  return (
    <section class="card stack">
      <p class="eyebrow">Conjure™ view · 7 days</p>
      <div class="row between"><span class={`signal ${v.direction === "long" ? "up" : v.direction === "short" ? "down" : ""}`}>{v.direction === "flat" ? "Stay flat" : v.direction}</span><span class="small">{pct(sig.data.probabilityUp)} up</span></div>
      <p class="small">{v.reason}</p>
      <p class="small muted">Leverage ceiling for this volatility: {v.maxSensibleLeverage}×. Backtest skill {pct(sig.data.backtest.skill, 1)} on {sig.data.backtest.testSize} unseen days. A forecast, not advice.</p>
    </section>
  );
}

function Positions({ account, markets, onDone }: { account?: Awaited<ReturnType<typeof perpAccount>>; markets: PerpMarket[]; onDone: () => void }) {
  const { prefs } = useStore();
  if (!account) return null;
  const run = async (p: ReturnType<typeof prepareClose>) => {
    try {
      await approveAndSubmitPerp(prefs.mode, p);
      toast("Done.");
      onDone();
    } catch (e) {
      if (errorText(e) !== "Cancelled.") toast(errorText(e), "err");
    }
  };
  return (
    <section class="card stack">
      <h3>Positions</h3>
      {!account.positions.length && <p class="small muted">No open positions.</p>}
      {account.positions.length > 0 && <div class="scroll-x"><table class="list">
        <thead><tr><th>Market</th><th class="r">Size</th><th class="r">Entry</th><th class="r">PnL</th><th class="r">Liq.</th><th /></tr></thead>
        <tbody>{account.positions.map((p) => {
          const m = markets.find((x) => x.name === p.coin);
          return (
            <tr>
              <td>{p.coin} <span class="small muted">{p.leverage}×</span></td>
              <td class={`r ${p.size > 0 ? "up" : "down"}`}>{num(p.size)}</td>
              <td class="r">{usd(p.entryPx)}</td>
              <td class={`r ${p.unrealizedPnl >= 0 ? "up" : "down"}`}>{usd(p.unrealizedPnl)}</td>
              <td class="r">{p.liquidationPx ? usd(p.liquidationPx) : "—"}</td>
              <td class="r">{m && <button class="btn ghost" onClick={() => run(prepareClose(m, p))}>Close</button>}</td>
            </tr>
          );
        })}</tbody>
      </table></div>}
      {(() => {
        // Hyperliquid also returns spot orders (coins like "@1115"); this screen lists perps only.
        const perpOrders = account.openOrders.flatMap((o) => {
          const m = markets.find((x) => x.name === o.coin);
          return m ? [{ o, m }] : [];
        });
        return perpOrders.length > 0 && <>
          <h3>Open orders</h3>
          <table class="list"><tbody>{perpOrders.map(({ o, m }) => (
            <tr><td>{o.coin} {o.side === "B" ? "buy" : "sell"} {o.sz} @ {o.limitPx}</td><td class="r"><button class="btn ghost" onClick={() => run(prepareCancel(m, o.oid))}>Cancel</button></td></tr>
          ))}</tbody></table>
        </>;
      })()}
    </section>
  );
}
