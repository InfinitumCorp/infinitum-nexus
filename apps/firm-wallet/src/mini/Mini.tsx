/**
 * $FIRM Mini: the wallet's one-thumb DEX, sized for Telegram (and any phone browser).
 * Same keys and vault as the full wallet (same origin), every signature still goes through the
 * wallet's own review sheet. Trades go straight from the device to Hyperliquid; swaps use the
 * full wallet's Uniswap / Jupiter screen.
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { conjureMarketSignal, perpView } from "@infinitum/conjure/markets";
import { perpAccount, prepareCancel, prepareClose, preparePerpOrder } from "../core/perps.ts";
import { asPerpMarket, assetForCoin, leverageSteps, prepareSpotOrder, spotBalances, ticketSummary, tickers, usdTransfer, type Ticker } from "../core/dex.ts";
import { cryptoCandles } from "../core/market-data.ts";
import { boot, errorText, getState, lock, requestApproval, toast, touch, useStore } from "../ui/store.ts";
import { ApprovalSheet, approveAndSubmitPerp, Copy, num, pct, Qr, Seg, Toast, usd, useAsync } from "../ui/kit.tsx";
import { Onboarding, Unlock } from "../ui/screens/Onboarding.tsx";
import { SwapScreen } from "../ui/screens/Swap.tsx";
import { MarketsGate } from "../ui/screens/Markets.tsx";
import { Deposit } from "../ui/screens/Perps.tsx";
import * as tg from "./telegram.ts";

type Tab = "trade" | "swap" | "portfolio" | "wallet";
const TABS: [Tab, string][] = [["trade", "Trade"], ["swap", "Swap"], ["portfolio", "Portfolio"], ["wallet", "Wallet"]];
type Sel = { kind: "perp" | "spot"; coin: string };

/** Poll while mounted; pauses when the page is hidden and never stacks a request on a slow one. */
function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[]) {
  const a = useAsync(fn, deps);
  const loading = useRef(a.loading);
  loading.current = a.loading;
  useEffect(() => {
    const id = setInterval(() => document.visibilityState === "visible" && !loading.current && a.reload(), ms);
    return () => clearInterval(id);
  }, deps);
  return a;
}

/** Telegram's native bottom button when inside Telegram; callers render their own button otherwise. */
function useMainButton(text: string | null, active: boolean, onPress: () => void) {
  const ref = useRef(onPress);
  ref.current = onPress;
  useEffect(() => tg.setMainButton(text ? { text, active } : null), [text, active]);
  useEffect(() => {
    const off = tg.on("main_button_pressed", () => ref.current());
    return () => {
      off();
      tg.setMainButton(null);
    };
  }, []);
}

const fail = (e: unknown) => {
  if (errorText(e) === "Cancelled.") return;
  tg.haptic("error");
  toast(errorText(e), "err");
};

export function MiniApp() {
  const st = useStore();
  const [tab, setTab] = useState<Tab>("trade");
  const [sel, setSel] = useState<Sel>({ kind: "perp", coin: "BTC" });

  useEffect(() => {
    tg.start();
    void boot();
    const activity = () => touch();
    addEventListener("pointerdown", activity);
    return () => removeEventListener("pointerdown", activity);
  }, []);
  useEffect(() => tg.setClosingConfirmation(!!st.session), [st.session]);
  useEffect(() => {
    tg.setBackButton(!!st.session && tab !== "trade");
    return tg.on("back_button_pressed", () => setTab("trade"));
  }, [tab, st.session]);

  if (!st.ready) return <div class="center"><p class="muted">Loading…</p></div>;

  let body;
  if (!st.vault) body = <Onboarding />;
  else if (!st.session) body = <Unlock />;
  else body = (
    <MarketsGate>
      {tab === "trade" && <Trade sel={sel} setSel={setSel} />}
      {tab === "swap" && <SwapScreen />}
      {tab === "portfolio" && <Portfolio onTrade={(s) => { setSel(s); setTab("trade"); }} />}
      {tab === "wallet" && <WalletTab />}
    </MarketsGate>
  );

  return (
    <div class="mini">
      <header class="mini-top">
        <span class="wordmark">$FIRM Mini<span class="tm">™</span></span>
        <span class="row">
          {st.session && <span class={`mode ${st.prefs.mode === "mainnet" ? "live" : ""}`}>{st.prefs.mode === "mainnet" ? "Mainnet" : "Testnet"}</span>}
          {st.session && <button class="btn ghost" type="button" onClick={lock}>Lock</button>}
        </span>
      </header>
      <main class="mini-body">{body}</main>
      {st.session && (
        <nav class="mini-nav" aria-label="Sections">
          {TABS.map(([t, label]) => (
            <button type="button" class={t === tab ? "on" : ""} aria-current={t === tab ? "page" : undefined} onClick={() => { tg.haptic("tap"); setTab(t); }}>{label}</button>
          ))}
        </nav>
      )}
      <ApprovalSheet />
      <Toast />
    </div>
  );
}

/* ---------------- Trade ---------------- */

const AMOUNTS = [10, 25, 50, 100, 250];
/** Unit-bridged spot tokens (UBTC, UETH…) share history with the perp of the same coin. */
const signalCoin = (t: Ticker) => (t.kind === "perp" ? t.coin : t.base.replace(/^U(?=[A-Z]{3,}$)/, ""));

function Trade({ sel, setSel }: { sel: Sel; setSel: (s: Sel) => void }) {
  const { prefs, session, approval } = useStore();
  const list = usePoll(() => tickers(prefs.mode, [sel.kind]), 10_000, [prefs.mode, sel.kind]);
  const spot = usePoll(() => spotBalances(prefs.mode, session!.evm.address), 20_000, [prefs.mode, session?.evm.address]);
  const [picking, setPicking] = useState(false);
  const [side, setSide] = useState<"long" | "short">("long");
  const [amount, setAmount] = useState("25");
  const [lev, setLev] = useState(2);
  const [busy, setBusy] = useState(false);

  const all = list.data ?? [];
  const t = all.find((x) => x.kind === sel.kind && x.coin === sel.coin) ?? [...all].filter((x) => x.kind === sel.kind).sort((a, b) => b.volume24h - a.volume24h)[0];
  const steps = t ? leverageSteps(t.maxLeverage) : [1];
  const lv = t?.kind === "perp" ? Math.min(lev, steps[steps.length - 1]!) : 1;
  const amt = Number(amount);
  const held = t?.kind === "spot" ? spot.data?.find((b) => b.coin === t.base) : undefined;
  const free = held ? held.total - held.hold : 0;
  const usdc = spot.data?.find((b) => b.coin === "USDC");
  const buyWord = t?.kind === "spot" ? (side === "long" ? "Buy" : "Sell") : side === "long" ? "Long" : "Short";
  const ready = !!t?.mid && amt >= 10 && !busy && !approval;

  const run = async () => {
    if (!t || !ready) return;
    setBusy(true);
    tg.haptic("tap");
    try {
      const order = t.kind === "perp"
        ? preparePerpOrder({ market: asPerpMarket(t), side, usd: amt, leverage: lv })
        : prepareSpotOrder({ ticker: t, side: side === "long" ? "buy" : "sell", usd: side === "long" ? amt : undefined, size: side === "short" ? Math.min(amt / t.mid!, free) : undefined });
      await approveAndSubmitPerp(prefs.mode, order, t.kind === "spot" ? "" : undefined);
      tg.haptic("success");
      toast(`${buyWord} ${t.base}: done.`);
      spot.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const label = t ? (busy ? "Working…" : `${buyWord} ${t.base} · $${amt || 0}`) : "Pick a market";
  useMainButton(picking || approval ? null : label, ready, run);

  const kindSeg = <Seg value={sel.kind} options={[{ value: "perp", label: "Perps" }, { value: "spot", label: "Spot" }]} onChange={(k) => setSel({ kind: k, coin: k === "perp" ? "BTC" : "" })} />;
  if (!t) {
    return (
      <div class="stack">
        {kindSeg}
        {list.error && !list.loading ? <><p class="small down">{list.error}</p><button class="btn" type="button" onClick={list.reload}>Try again</button></>
          : <p class="muted">{list.loading ? `Loading Hyperliquid ${sel.kind === "perp" ? "perps" : "spot"}…` : "No markets right now."}</p>}
      </div>
    );
  }
  if (picking) return <Picker list={all} kind={sel.kind} onPick={(x) => { setSel({ kind: x.kind, coin: x.coin }); setPicking(false); }} onClose={() => setPicking(false)} />;

  const sc = signalCoin(t);
  return (
    <div class="stack">
      {kindSeg}
      <button type="button" class="mini-market" onClick={() => setPicking(true)}>
        <span><b>{t.label}</b>{t.kind === "perp" ? "-PERP" : ""} <span class="muted">▾</span></span>
        <span class="r"><b>{usd(t.mid)}</b><br /><Change c={t.change24h} /></span>
      </button>
      <div class="mini-sides">
        <button type="button" class={`btn block ${side === "long" ? "solid" : ""}`} onClick={() => setSide("long")}>{t.kind === "spot" ? "Buy" : "Long"}</button>
        <button type="button" class={`btn block ${side === "short" ? "danger" : ""}`} onClick={() => setSide("short")}>{t.kind === "spot" ? "Sell" : "Short"}</button>
      </div>
      <div class="field">
        <label>Amount (USD)</label>
        <input inputMode="decimal" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value.replace(",", "."))} />
        <div class="chips">
          {AMOUNTS.map((a) => <button type="button" class={`chip ${amt === a ? "on" : ""}`} onClick={() => setAmount(String(a))}>${a}</button>)}
          {t.kind === "spot" && side === "short" && free > 0 && <button type="button" class="chip" onClick={() => setAmount((free * t.mid!).toFixed(2))}>Max</button>}
        </div>
      </div>
      {t.kind === "perp" && (
        <div class="field">
          <label>Leverage</label>
          <div class="chips">{steps.map((x) => <button type="button" class={`chip ${lv === x ? "on" : ""}`} onClick={() => setLev(x)}>{x}×</button>)}</div>
        </div>
      )}
      <p class="small muted">
        {ticketSummary(t, side, amt, lv)}
        {t.kind === "spot" && side === "long" && ` · spot USDC ${usdc ? num(usdc.total - usdc.hold, 2) : "0"}`}
        {t.kind === "spot" && side === "short" && ` · you have ${num(free)} ${t.base}`}
        {t.kind === "perp" && t.funding !== undefined && ` · funding ${(t.funding * 100).toFixed(4)}%/h`}
      </p>
      {amt > 0 && amt < 10 && <p class="small down">Hyperliquid's minimum order is $10.</p>}
      {!tg.inTelegram && <button type="button" class={`btn block ${side === "long" ? "solid" : "danger"}`} disabled={!ready} onClick={run}>{label}</button>}
      {sc && <Signal coin={sc} />}
      <p class="small muted">Market order on Hyperliquid, filled within 1% of the price. Hyperliquid sets fees and funding; Infinitum adds nothing.{t.kind === "perp" && " Leverage can lose your whole margin."}</p>
    </div>
  );
}

function Change({ c }: { c?: number }) {
  if (c === undefined) return <span class="small muted">—</span>;
  return <span class={`small ${c >= 0 ? "up" : "down"}`}>{c >= 0 ? "▲" : "▼"} {Math.abs(c * 100).toFixed(2)}%</span>;
}

function Picker({ list, kind, onPick, onClose }: { list: Ticker[]; kind: "perp" | "spot"; onPick: (t: Ticker) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  useEffect(() => {
    tg.setBackButton(true);
    return tg.on("back_button_pressed", onClose);
  }, []);
  const rows = useMemo(
    () => list.filter((t) => t.kind === kind && t.mid && t.label.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => b.volume24h - a.volume24h).slice(0, 80),
    [list, kind, q],
  );
  return (
    <div class="stack">
      <div class="row">
        <input autoFocus type="search" placeholder={kind === "perp" ? "BTC, ETH, SOL…" : "HYPE, UBTC…"} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} style={{ flex: 1, minHeight: 42, border: "1px solid var(--line)", padding: "0 12px", background: "var(--paper)", color: "var(--ink)" }} />
        <button class="btn ghost" type="button" onClick={onClose}>Close</button>
      </div>
      <ul class="mini-list">
        {rows.map((t) => (
          <li><button type="button" onClick={() => onPick(t)}>
            <span><b>{t.label}</b><br /><span class="small muted">{compact(t.volume24h)} 24h{t.kind === "perp" ? ` · ${t.maxLeverage}×` : ""}</span></span>
            <span class="r">{usd(t.mid)}<br /><Change c={t.change24h} /></span>
          </button></li>
        ))}
      </ul>
    </div>
  );
}

const compact = (n: number) => `$${Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n)}`;

function Signal({ coin }: { coin: string }) {
  const sig = useAsync(async () => conjureMarketSignal(coin, await cryptoCandles(coin), { horizonDays: 7 }), [coin]);
  if (!sig.data) return sig.loading ? <p class="small muted">Conjure™ is reading {coin}…</p> : null;
  const v = perpView(sig.data);
  return (
    <section class="card stack">
      <div class="row between">
        <span class="eyebrow">Conjure™ · 7 days</span>
        <span class={`signal ${v.direction === "long" ? "up" : v.direction === "short" ? "down" : ""}`}>{v.direction === "flat" ? "No edge" : v.direction}</span>
      </div>
      <p class="small">{pct(sig.data.probabilityUp)} chance up. {v.reason}</p>
      <p class="small muted">Sensible leverage ≤ {v.maxSensibleLeverage}×. A forecast, not advice.</p>
    </section>
  );
}

/* ---------------- Portfolio ---------------- */

function Portfolio({ onTrade }: { onTrade: (s: Sel) => void }) {
  const { prefs, session } = useStore();
  const addr = session!.evm.address;
  // Perps arrive first (small list), so Close works while the bigger spot list is still loading.
  const perps = useAsync(() => tickers(prefs.mode, ["perp"]), [prefs.mode]);
  const spots = useAsync(() => tickers(prefs.mode, ["spot"]), [prefs.mode]);
  const acct = usePoll(() => perpAccount(prefs.mode, addr), 15_000, [prefs.mode, addr]);
  const spot = usePoll(() => spotBalances(prefs.mode, addr), 15_000, [prefs.mode, addr]);
  const all = [...(perps.data ?? []), ...(spots.data ?? [])];
  const reload = () => { acct.reload(); spot.reload(); };
  const run = async (p: ReturnType<typeof prepareClose>) => {
    try {
      await approveAndSubmitPerp(prefs.mode, p);
      tg.haptic("success");
      toast("Done.");
      reload();
    } catch (e) {
      fail(e);
    }
  };
  const spotValue = (coin: string, total: number): number | undefined => {
    if (coin === "USDC") return total;
    const mid = all.find((t) => t.kind === "spot" && t.base === coin)?.mid;
    return mid !== undefined ? mid * total : spots.loading ? undefined : 0;
  };
  const spotTotal = (spot.data ?? []).reduce((s, b) => s + (spotValue(b.coin, b.total) ?? 0), 0);

  return (
    <div class="stack">
      <section class="card stack">
        <div class="row between"><span class="eyebrow">Hyperliquid account</span><button class="btn ghost" type="button" onClick={reload}>Refresh</button></div>
        {acct.error && <p class="small down">{acct.error}</p>}
        <dl class="kv">
          <dt>Perps value</dt><dd>{usd(acct.data?.accountValue)}</dd>
          <dt>Withdrawable</dt><dd>{usd(acct.data?.withdrawable)}</dd>
          <dt>Spot value</dt><dd>{spot.data ? `${usd(spotTotal)}${spots.loading ? " (pricing…)" : ""}` : "—"}</dd>
        </dl>
        <Transfer onDone={reload} />
      </section>

      <section class="card stack">
        <h3>Positions</h3>
        {acct.data && !acct.data.positions.length && <p class="small muted">No open positions.</p>}
        {acct.data?.positions.map((p) => {
          const t = all.find((x) => x.kind === "perp" && x.coin === p.coin);
          return (
            <div class="mini-pos">
              <div class="row between">
                <b class={p.size > 0 ? "up" : "down"}>{p.size > 0 ? "Long" : "Short"} {p.coin} {p.leverage}×</b>
                <b class={p.unrealizedPnl >= 0 ? "up" : "down"}>{usd(p.unrealizedPnl)}</b>
              </div>
              <div class="small muted">{num(Math.abs(p.size))} {p.coin} · entry {usd(p.entryPx)} · liq. {p.liquidationPx ? usd(p.liquidationPx) : "—"}</div>
              <div class="row">
                {t && <button class="btn ghost" type="button" onClick={() => run(prepareClose(asPerpMarket(t), p))}>Close</button>}
                <button class="btn ghost" type="button" onClick={() => onTrade({ kind: "perp", coin: p.coin })}>Trade</button>
              </div>
            </div>
          );
        })}
      </section>

      {!!acct.data?.openOrders.length && (
        <section class="card stack">
          <h3>Open orders</h3>
          {acct.data.openOrders.map((o) => {
            const t = all.find((x) => x.coin === o.coin);
            const asset = assetForCoin(o.coin, all);
            return (
              <div class="row between">
                <span class="small">{t?.label ?? o.coin} {o.side === "B" ? "buy" : "sell"} {o.sz} @ {o.limitPx}</span>
                {asset !== undefined && t && <button class="btn ghost" type="button" onClick={() => run(prepareCancel(asPerpMarket(t), o.oid))}>Cancel</button>}
              </div>
            );
          })}
        </section>
      )}

      <section class="card stack">
        <h3>Spot balances</h3>
        {spot.data && !spot.data.length && <p class="small muted">No spot balances yet. Move USDC from perps above to buy spot.</p>}
        {spot.data?.map((b) => {
          const t = all.find((x) => x.kind === "spot" && x.base === b.coin);
          return (
            <div class="row between">
              <span><b>{b.coin}</b> <span class="small muted">{num(b.total)}{b.hold > 0 ? ` (${num(b.hold)} in orders)` : ""}</span></span>
              <span class="row"><span class="small">{usd(spotValue(b.coin, b.total))}</span>{t && <button class="btn ghost" type="button" onClick={() => onTrade({ kind: "spot", coin: t.coin })}>Trade</button>}</span>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function Transfer({ onDone }: { onDone: () => void }) {
  const { prefs } = useStore();
  const [amount, setAmount] = useState("");
  const [toPerp, setToPerp] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <div class="stack">
      <Seg value={toPerp ? "perp" : "spot"} options={[{ value: "spot", label: "Perps → Spot" }, { value: "perp", label: "Spot → Perps" }]} onChange={(v) => setToPerp(v === "perp")} />
      <div class="row">
        <input inputMode="decimal" placeholder="USDC" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value.replace(",", "."))} style={{ flex: 1, minHeight: 42, border: "1px solid var(--line)", padding: "0 12px", background: "var(--paper)", color: "var(--ink)" }} />
        <button class="btn" type="button" disabled={busy || !(Number(amount) > 0)} onClick={async () => {
          setBusy(true);
          try {
            const ok = await requestApproval({
              title: `Move ${amount} USDC to ${toPerp ? "perps" : "spot"}`,
              details: [["From", toPerp ? "Hyperliquid spot" : "Hyperliquid perps"], ["To", toPerp ? "Hyperliquid perps" : "Hyperliquid spot"], ["Amount", `${amount} USDC`], ["Fee", "None"]],
              confirmLabel: "Approve and sign",
            });
            if (!ok) throw new Error("Cancelled.");
            await usdTransfer(prefs.mode, getState().session!.evm, Number(amount), toPerp);
            tg.haptic("success");
            toast("Moved.");
            setAmount("");
            onDone();
          } catch (e) {
            fail(e);
          } finally {
            setBusy(false);
          }
        }}>Move</button>
      </div>
    </div>
  );
}

/* ---------------- Wallet ---------------- */

function WalletTab() {
  const { session } = useStore();
  const [qr, setQr] = useState<"evm" | "sol" | null>(null);
  const rows: ["evm" | "sol", string, string][] = [
    ["evm", "Ethereum · Base · Arbitrum · Hyperliquid", session!.evm.address],
    ["sol", "Solana", session!.sol.address],
  ];
  return (
    <div class="stack">
      <section class="card stack">
        <span class="eyebrow">Receive</span>
        {rows.map(([k, name, a]) => (
          <div class="stack">
            <div class="small muted">{name}</div>
            <div class="mono small" style={{ wordBreak: "break-all" }}>{a}</div>
            <div class="row"><Copy text={a} /><button class="btn ghost" type="button" onClick={() => setQr(qr === k ? null : k)}>{qr === k ? "Hide QR" : "QR"}</button></div>
            {qr === k && <Qr text={a} />}
          </div>
        ))}
      </section>
      <section class="card stack">
        <span class="eyebrow">Fund trading</span>
        <Deposit onDone={() => {}} />
      </section>
      <a class="btn block" href="/">Open the full $FIRM Wallet™</a>
      <p class="small muted">Self-custody: your keys stay on this device, encrypted with your password. Telegram and Infinitum never see them. Keep your recovery phrase offline.</p>
    </div>
  );
}
