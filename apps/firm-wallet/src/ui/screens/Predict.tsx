import { useEffect, useMemo, useState } from "preact/hooks";
import { conjureMarketSignal, probabilityAbove, DISCLAIMER } from "@infinitum/conjure/markets";
import { CONJURE_SWARM } from "../../core/config.ts";
import { cryptoCandles } from "../../core/market-data.ts";
import {
  buyQuote, CATEGORIES, cryptoThreshold, thresholdChance, fetchEvent, kalshiAll, kalshiEvents, orderBook, polymarketEvents, polymarketPositions,
  polymarketSearch, priceHistory, similarEvents, triggeredAlerts,
  type HistoryRange, type Outcome, type PredictionEvent, type PricePoint, type Venue,
} from "../../core/predictions.ts";
import { errorText, savePrefs, toast, useStore, getState } from "../store.ts";
import { Field, pct, Prob, Seg, usd, useAsync } from "../kit.tsx";
import { MarketsGate } from "./Markets.tsx";

const VENUE_NAME: Record<Venue, string> = { polymarket: "Polymarket", kalshi: "Kalshi" };
/** Cents, with a decimal only where the venue ticks finer than a cent (1.6¢). */
const cents = (p?: number) => {
  if (p === undefined) return "—";
  const c = p * 100;
  return `${Math.abs(c - Math.round(c)) < 0.05 ? Math.round(c) : c.toFixed(1)}¢`;
};
const qty = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const points = (c?: number) => (c === undefined || Math.abs(c) < 0.005 ? "" : `${c > 0 ? "▲" : "▼"} ${Math.abs(c * 100).toFixed(0)}`);
const compact = (n: number) => `$${n.toLocaleString(undefined, { notation: "compact", maximumFractionDigits: 1 })}`;
const when = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }) : "");

export function PredictScreen() {
  return (
    <div class="stack">
      <p class="eyebrow">Prediction markets · Polymarket and Kalshi</p>
      <h1>Predict</h1>
      <MarketsGate><Predict /></MarketsGate>
    </div>
  );
}

type View = "browse" | "watch" | "positions";

function Predict() {
  const { prefs } = useStore();
  const [view, setView] = useState<View>("browse");
  const [venue, setVenue] = useState<"all" | Venue>("all");
  const [cat, setCat] = useState("trending");
  const [sort, setSort] = useState<"volume" | "ending">("volume");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<PredictionEvent | null>(null);
  useAlertWatcher();

  const category = CATEGORIES.find((c) => c.id === cat)!;
  // Each venue loads on its own, so the fast one shows while the slow one (often Kalshi) catches up.
  const want = (v: Venue) => venue === "all" || venue === v;
  const poly = useAsync(async () => (want("polymarket") ? (query ? polymarketSearch(query) : polymarketEvents({ category, sort })) : []), [venue, cat, sort, query]);
  const kal = useAsync(async () => (want("kalshi") ? kalshiEvents({ category: query ? undefined : category, sort, query: query || undefined }) : []), [venue, cat, sort, query]);
  const events = useMemo(() => {
    const all = [...(poly.data ?? []), ...(kal.data ?? [])];
    return all.sort(sort === "ending" ? (a, b) => (a.endDate ?? "9").localeCompare(b.endDate ?? "9") : (a, b) => b.volume24h - a.volume24h);
  }, [poly.data, kal.data, sort]);
  const loading = [poly.loading && want("polymarket") && "Polymarket", kal.loading && want("kalshi") && "Kalshi"].filter(Boolean) as string[];

  if (open) return <EventDetail event={open} onBack={() => setOpen(null)} />;

  return (
    <div class="stack">
      <div class="row between wrapflex">
        <Seg value={view} options={[{ value: "browse", label: "Markets" }, { value: "watch", label: `Watchlist (${prefs.predictionWatch.length})` }, { value: "positions", label: "Positions" }]} onChange={setView} />
        {prefs.predictionAlerts.length > 0 && <span class="small muted">{prefs.predictionAlerts.length} price alert{prefs.predictionAlerts.length === 1 ? "" : "s"} on</span>}
      </div>

      {view === "watch" && <Watchlist onOpen={setOpen} />}
      {view === "positions" && <Positions />}
      {view === "browse" && <>
        <form class="row wrapflex" onSubmit={(e) => { e.preventDefault(); setQuery(draft.trim()); }}>
          <input type="search" placeholder="Search markets (e.g. Fed rates, election, bitcoin)" value={draft} onInput={(e) => setDraft((e.target as HTMLInputElement).value)} style={{ flex: 1, minWidth: 220, minHeight: 42, border: "1px solid var(--line)", padding: "0 12px", background: "var(--paper)" }} />
          <button class="btn" type="submit">Search</button>
          {query && <button class="btn ghost" type="button" onClick={() => { setDraft(""); setQuery(""); }}>Clear</button>}
        </form>
        <div class="row between wrapflex">
          <Seg value={venue} options={[{ value: "all", label: "All venues" }, { value: "polymarket", label: "Polymarket" }, { value: "kalshi", label: "Kalshi" }]} onChange={setVenue} />
          <Seg value={sort} options={[{ value: "volume", label: "24h volume" }, { value: "ending", label: "Ending soon" }]} onChange={setSort} />
        </div>
        {!query && <div class="chips">{CATEGORIES.map((c) => <button class={`chip ${c.id === cat ? "on" : ""}`} onClick={() => setCat(c.id)}>{c.label}</button>)}</div>}
        {query && <p class="small muted">Results for “{query}”</p>}
        {loading.length > 0 && <p class="small muted">Loading {loading.join(" and ")}…{loading.includes("Kalshi") ? " Kalshi can take a few seconds." : ""}</p>}
        {poly.error && <p class="small down">Polymarket: {poly.error}</p>}
        {kal.error && <p class="small down">Kalshi: {kal.error}</p>}
        {!loading.length && !events.length && <p class="muted">No open markets here.</p>}
        <div class="grid pm-grid">{events.map((e) => <EventCard event={e} onOpen={() => setOpen(e)} />)}</div>
      </>}
      <p class="small muted">Odds and volume are the venues' own live data. Trades open on Polymarket or Kalshi, each with its own account and rules. Infinitum adds no fees. {DISCLAIMER}</p>
    </div>
  );
}

function Star({ event }: { event: PredictionEvent }) {
  const { prefs } = useStore();
  const on = prefs.predictionWatch.some((w) => w.venue === event.venue && w.id === event.id);
  return (
    <button class="btn ghost star" aria-pressed={on} title={on ? "Remove from watchlist" : "Add to watchlist"} onClick={(e) => {
      e.stopPropagation();
      savePrefs({ predictionWatch: on ? prefs.predictionWatch.filter((w) => !(w.venue === event.venue && w.id === event.id)) : [...prefs.predictionWatch, { venue: event.venue, id: event.id, title: event.title }] });
    }}>{on ? "★" : "☆"}</button>
  );
}

function EventCard({ event, onOpen }: { event: PredictionEvent; onOpen: () => void }) {
  const top = event.outcomes.slice(0, 3);
  return (
    <section class="card pm-card stack" role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === "Enter" && onOpen()}>
      <div class="row between">
        <span class="badge">{VENUE_NAME[event.venue]}{event.category ? ` · ${event.category}` : ""}</span>
        <Star event={event} />
      </div>
      <h3>{event.title}</h3>
      {event.subtitle && <p class="small muted">{event.subtitle}</p>}
      {top.map((o) => (
        <div>
          <div class="row between small"><span>{event.outcomes.length > 1 ? o.label : "Yes"}</span><span><span class={o.change24h && o.change24h > 0 ? "up" : "down"}>{points(o.change24h)}</span> <b>{pct(o.price)}</b></span></div>
          <Prob p={o.price} />
        </div>
      ))}
      {event.outcomes.length > 3 && <p class="small muted">+{event.outcomes.length - 3} more</p>}
      <p class="small muted">{compact(event.volume24h)} 24h vol{event.endDate ? ` · ends ${when(event.endDate)}` : ""}</p>
    </section>
  );
}

function EventDetail({ event: initial, onBack }: { event: PredictionEvent; onBack: () => void }) {
  const fresh = useAsync(() => fetchEvent(initial.venue, initial.id).then((e) => e ?? initial).catch(() => initial), [initial.venue, initial.id]);
  const event = fresh.data ?? initial;
  const [sel, setSel] = useState<string>(initial.outcomes[0]?.id ?? "");
  const outcome = event.outcomes.find((o) => o.id === sel) ?? event.outcomes[0];
  const [showRules, setShowRules] = useState(false);
  if (!outcome) return <p class="muted">This market has closed.</p>;
  const multi = event.outcomes.length > 1;

  return (
    <div class="stack">
      <div class="row between wrapflex">
        <button class="btn ghost" onClick={onBack}>← All markets</button>
        <div class="row"><Star event={event} /><a class="btn solid" href={event.url} target="_blank" rel="noopener noreferrer">Trade on {VENUE_NAME[event.venue]}</a></div>
      </div>
      <div>
        <span class="badge">{VENUE_NAME[event.venue]}{event.category ? ` · ${event.category}` : ""}</span>
        <h2>{event.title}</h2>
        <p class="small muted">{event.subtitle ? `${event.subtitle} · ` : ""}{compact(event.volume24h)} 24h vol{event.volume ? ` · ${compact(event.volume)} total` : ""}{event.endDate ? ` · ends ${when(event.endDate)}` : ""}</p>
      </div>

      <div class="grid two">
        <section class="card stack">
          <table class="list">
            <thead><tr><th>{multi ? "Outcome" : "Market"}</th><th class="r">Chance</th><th class="r">Yes</th><th class="r">No</th></tr></thead>
            <tbody>{event.outcomes.map((o) => (
              <tr style={{ cursor: "pointer" }} aria-selected={o.id === outcome.id} onClick={() => setSel(o.id)}>
                <td><b>{o.id === outcome.id ? "▸ " : ""}{multi ? o.label : "Yes"}</b> <span class={`small ${o.change24h && o.change24h > 0 ? "up" : "down"}`}>{points(o.change24h)}</span><Prob p={o.price} /></td>
                <td class="r"><b>{pct(o.price)}</b></td>
                <td class="r small">{cents(o.ask ?? o.price)}</td>
                <td class="r small">{cents(o.bid !== undefined ? 1 - o.bid : 1 - o.price)}</td>
              </tr>
            ))}</tbody>
          </table>
          <PriceChart venue={event.venue} outcome={outcome} />
          <Book venue={event.venue} outcome={outcome} />
        </section>

        <div class="stack">
          <Ticket key={`t:${outcome.id}`} event={event} outcome={outcome} />
          <ConjureCard event={event} outcome={outcome} />
          <AlertCard key={`${event.venue}:${outcome.id}`} event={event} outcome={outcome} />
          <Elsewhere event={event} />
        </div>
      </div>

      {event.rules && <section class="card stack">
        <div class="row between"><h3>Rules</h3><button class="btn ghost" onClick={() => setShowRules(!showRules)}>{showRules ? "Hide" : "Show"}</button></div>
        {showRules && <p class="small" style={{ whiteSpace: "pre-wrap" }}>{event.rules}</p>}
        <p class="small muted">The venue decides how this market resolves. Read its full rules there before trading.</p>
      </section>}
    </div>
  );
}

function PriceChart({ venue, outcome }: { venue: Venue; outcome: Outcome }) {
  const [range, setRange] = useState<HistoryRange>("1w");
  const hist = useAsync(() => priceHistory(venue, outcome, range), [venue, outcome.id, range]);
  return (
    <div class="stack">
      <div class="row between"><span class="small muted">Chance over time · {outcome.label}</span><Seg value={range} options={[{ value: "1d", label: "1D" }, { value: "1w", label: "1W" }, { value: "1m", label: "1M" }]} onChange={setRange} /></div>
      {hist.loading ? <div class="spark muted small">Loading…</div> : hist.error ? <p class="small down">{hist.error}</p> : <Spark points={hist.data ?? []} />}
    </div>
  );
}

export function Spark({ points: pts }: { points: PricePoint[] }) {
  if (pts.length < 2) return <div class="spark muted small">Not enough trading yet to chart.</div>;
  const W = 600, H = 160, t0 = pts[0]!.t, t1 = pts[pts.length - 1]!.t || t0 + 1;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (p: number) => H - p * H;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!.p, first = pts[0]!.p;
  return (
    <svg class="spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`From ${pct(first)} to ${pct(last)}`}>
      {[0.25, 0.5, 0.75].map((g) => <line x1="0" x2={W} y1={y(g)} y2={y(g)} class="grid-line" />)}
      <path d={d} fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke" />
      <text x={W - 4} y={Math.min(H - 6, Math.max(14, y(last) - 6))} text-anchor="end" class="spark-label">{pct(last)}</text>
    </svg>
  );
}

function Book({ venue, outcome }: { venue: Venue; outcome: Outcome }) {
  const book = useAsync(() => orderBook(venue, outcome), [venue, outcome.id]);
  if (book.loading) return <p class="small muted">Loading order book…</p>;
  if (book.error || !book.data) return <p class="small down">{book.error ?? "No order book."}</p>;
  const { bids, asks } = book.data;
  const max = Math.max(1, ...bids.map((l) => l.size), ...asks.map((l) => l.size));
  const spread = bids[0] && asks[0] ? asks[0].price - bids[0].price : undefined;
  const Row = ({ price, size, side }: { price: number; size: number; side: "bid" | "ask" }) => (
    <tr class={`book-${side}`}><td style={{ backgroundSize: `${(size / max) * 100}% 100%` }}>{cents(price)}</td><td class="r">{qty(size)}</td><td class="r">{usd(price * size)}</td></tr>
  );
  return (
    <div class="stack">
      <div class="row between"><span class="small muted">Order book · Yes</span>{spread !== undefined && <span class="small muted">Spread {cents(spread)}</span>}</div>
      <table class="list book"><thead><tr><th>Price</th><th class="r">Shares</th><th class="r">Total</th></tr></thead>
        <tbody>{[...asks].reverse().map((l) => <Row {...l} side="ask" />)}{bids.map((l) => <Row {...l} side="bid" />)}</tbody>
      </table>
      {!bids.length && !asks.length && <p class="small muted">No resting orders right now.</p>}
    </div>
  );
}

function Ticket({ event, outcome }: { event: PredictionEvent; outcome: Outcome }) {
  const [side, setSide] = useState<"yes" | "no">("yes");
  const [amount, setAmount] = useState("100");
  const price = side === "yes" ? outcome.ask ?? outcome.price : outcome.bid !== undefined ? 1 - outcome.bid : 1 - outcome.price;
  const q = buyQuote(event.venue, price, Number(amount) || 0);
  return (
    <section class="card ink stack">
      <h3>Buy {event.outcomes.length > 1 ? `· ${outcome.label}` : ""}</h3>
      <Seg value={side} options={[{ value: "yes", label: `Yes ${cents(outcome.ask ?? outcome.price)}` }, { value: "no", label: `No ${cents(outcome.bid !== undefined ? 1 - outcome.bid : 1 - outcome.price)}` }]} onChange={setSide} />
      <Field label="Amount (USD)"><input inputMode="decimal" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} /></Field>
      <dl class="kv">
        <dt>Shares</dt><dd>{qty(q.shares)} at {cents(price)}</dd>
        <dt>To win</dt><dd class="up">{usd(q.payout)} <span class="small muted">(profit {usd(q.profit)})</span></dd>
        <dt>Fee</dt><dd>{event.venue === "kalshi" ? `${usd(q.fee)} (Kalshi taker fee)` : "Set by Polymarket for this market"}</dd>
        <dt>Break-even</dt><dd>{pct(q.breakEven, 1)} chance</dd>
      </dl>
      <a class="btn solid block" href={event.url} target="_blank" rel="noopener noreferrer">Buy {side === "yes" ? "Yes" : "No"} on {VENUE_NAME[event.venue]}</a>
      <p class="small muted">{event.venue === "polymarket" ? "Polymarket settles in USDC on Polygon." : "Kalshi is a CFTC-regulated exchange with its own account and verification."} Prices move; the venue shows the final price before you confirm.</p>
    </section>
  );
}

function ConjureCard({ event, outcome }: { event: PredictionEvent; outcome: Outcome }) {
  const threshold = useMemo(() => cryptoThreshold(event.title, outcome.label), [event.title, outcome.label]);
  const [swarm, setSwarm] = useState("");
  const model = useAsync(async () => {
    if (!threshold || !event.endDate) return null;
    const s = conjureMarketSignal(threshold.coin, await cryptoCandles(threshold.coin), { horizonDays: 7 });
    const days = Math.max(0, (Date.parse(event.endDate) - Date.now()) / 86_400_000);
    // Use the model's drift only when it proved an edge on unseen days; otherwise volatility alone.
    const drift = s.backtest.edge ? Math.log(1 + s.expectedReturn) / s.horizonDays : 0;
    const pAbove = probabilityAbove(s.price, threshold.strike, days, drift, s.dailyVol);
    return { p: thresholdChance(threshold, s.price, pAbove), s, days };
  }, [threshold?.coin, threshold?.strike, event.endDate]);

  if (!threshold && !CONJURE_SWARM) return null;
  return (
    <section class="card stack">
      <p class="eyebrow">Conjure™</p>
      {threshold && model.loading && <p class="small muted">Conjure is pricing {threshold.coin} at {usd(threshold.strike)}…</p>}
      {threshold && model.data && <>
        <div class="row between"><span>Conjure's chance</span><b>{pct(model.data.p)}</b></div>
        <Prob p={model.data.p} />
        <div class="row between small"><span class="muted">Market's chance</span><span>{pct(outcome.price)}</span></div>
        <p class="small">{threshold.coin} is {usd(model.data.s.price)} now. This asks whether it {threshold.touch ? `${threshold.above ? "reaches" : "dips to"} ${usd(threshold.strike)} at any point` : `ends ${threshold.above ? "at or above" : "below"} ${usd(threshold.strike)}`} in the next {model.data.days.toFixed(1)} days.
          {" "}{model.data.s.backtest.edge ? "Uses Conjure's trend, which beat the base rate on unseen days." : "Conjure found no proven trend edge, so this uses volatility alone."}
          {Math.abs(model.data.p - outcome.price) >= 0.1 && " The gap is large: worth a closer look, not a sure thing."}</p>
      </>}
      {CONJURE_SWARM && <button class="btn ghost" onClick={async () => {
        try {
          const res = await fetch("/api/conjure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: `${event.title}${event.outcomes.length > 1 ? ` — ${outcome.label}` : ""}`.slice(0, 400), context: `Market price ${pct(outcome.price)} on ${VENUE_NAME[event.venue]}. Ends ${event.endDate ?? "unknown"}.` }) });
          const j = (await res.json()) as { id?: string; error?: string };
          if (!res.ok) throw new Error(j.error ?? "The swarm is unavailable.");
          setSwarm(`Swarm forecast started (${j.id}). It takes a few minutes.`);
        } catch (e) { toast(errorText(e), "err"); }
      }}>Ask the @conjure swarm</button>}
      {swarm && <p class="note">{swarm}</p>}
      <p class="small muted">A forecast, not advice.</p>
    </section>
  );
}

function AlertCard({ event, outcome }: { event: PredictionEvent; outcome: Outcome }) {
  const { prefs } = useStore();
  const [above, setAbove] = useState<"above" | "below">(outcome.price < 0.5 ? "above" : "below");
  const [level, setLevel] = useState(String(Math.round(outcome.price * 100 + (outcome.price < 0.5 ? 10 : -10))));
  const mine = prefs.predictionAlerts.filter((a) => a.venue === event.venue && a.outcomeId === outcome.id);
  const value = Number(level);
  return (
    <section class="card stack">
      <h3>Price alert</h3>
      <div class="row wrapflex">
        <Seg value={above} options={[{ value: "above", label: "Rises to" }, { value: "below", label: "Falls to" }]} onChange={setAbove} />
        <input inputMode="numeric" value={level} onInput={(e) => setLevel((e.target as HTMLInputElement).value)} style={{ width: 70, minHeight: 38, border: "1px solid var(--line)", padding: "0 8px", background: "var(--paper)" }} aria-label="Chance in percent" /> <span class="small">%</span>
        <button class="btn" disabled={!(value > 0 && value < 100)} onClick={async () => {
          if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission().catch(() => undefined);
          await savePrefs({ predictionAlerts: [...prefs.predictionAlerts, { venue: event.venue, eventId: event.id, outcomeId: outcome.id, label: outcome.label, eventTitle: event.title, above: above === "above", price: value / 100 }] });
          toast("Alert set.");
        }}>Set alert</button>
      </div>
      {mine.map((a) => <div class="row between small"><span>When {a.above ? "≥" : "≤"} {pct(a.price)}</span><button class="btn ghost" onClick={() => savePrefs({ predictionAlerts: prefs.predictionAlerts.filter((x) => x !== a) })}>Remove</button></div>)}
      <p class="small muted">Checked every minute while this wallet is open on the Predict tab.</p>
    </section>
  );
}

function Elsewhere({ event }: { event: PredictionEvent }) {
  const other: Venue = event.venue === "polymarket" ? "kalshi" : "polymarket";
  const matches = useAsync(async () => {
    const words = [...new Set(event.title.replace(/[^\w\s$.,]/g, " ").split(/\s+/).filter((w) => w.length > 3))].slice(0, 4).join(" ");
    const pool = other === "kalshi" ? await kalshiAll() : await polymarketSearch(words || event.title);
    return similarEvents(event, pool);
  }, [event.venue, event.id]);
  return (
    <section class="card stack">
      <h3>Same question on {VENUE_NAME[other]}</h3>
      {matches.loading && <p class="small muted">Looking…</p>}
      {matches.data && !matches.data.length && <p class="small muted">No close match found.</p>}
      {matches.data?.map(({ event: m }) => {
        const top = m.outcomes[0]!;
        const here = event.outcomes.find((o) => o.label.toLowerCase() === top.label.toLowerCase()) ?? (event.outcomes.length === 1 ? event.outcomes[0] : undefined);
        return (
          <a class="row between small" href={m.url} target="_blank" rel="noopener noreferrer">
            <span>{m.title}{m.outcomes.length > 1 ? ` · ${top.label}` : ""}</span>
            <span><b>{pct(top.price)}</b>{here ? <span class="muted"> vs {pct(here.price)} here</span> : null}</span>
          </a>
        );
      })}
      <p class="small muted">Matched by wording; check that both resolve the same way before comparing prices.</p>
    </section>
  );
}

function Watchlist({ onOpen }: { onOpen: (e: PredictionEvent) => void }) {
  const { prefs } = useStore();
  const items = useAsync(async () => (await Promise.all(prefs.predictionWatch.map((w) => fetchEvent(w.venue, w.id).catch(() => null)))).filter((e): e is PredictionEvent => !!e), [prefs.predictionWatch.map((w) => w.id).join(",")]);
  if (!prefs.predictionWatch.length) return <p class="muted">Star a market (☆) to follow it here.</p>;
  if (items.loading) return <p class="muted">Loading your watchlist…</p>;
  const missing = prefs.predictionWatch.length - (items.data?.length ?? 0);
  return (
    <div class="stack">
      <div class="grid pm-grid">{items.data?.map((e) => <EventCard event={e} onOpen={() => onOpen(e)} />)}</div>
      {missing > 0 && <p class="small muted">{missing} starred market{missing === 1 ? " has" : "s have"} closed or couldn't be loaded.</p>}
    </div>
  );
}

function Positions() {
  const { session } = useStore();
  const pos = useAsync(() => polymarketPositions(session!.evm.address), [session?.evm.address]);
  return (
    <section class="card stack">
      <h3>Polymarket positions</h3>
      <p class="small muted">Held by this wallet's address <span class="mono">{session!.evm.address.slice(0, 8)}…</span>. Kalshi positions live in your Kalshi account.</p>
      {pos.loading && <p class="muted">Loading…</p>}
      {pos.error && <p class="down small">{pos.error}</p>}
      {pos.data && !pos.data.length && <p class="muted">No open positions.</p>}
      {pos.data && pos.data.length > 0 && <table class="list"><thead><tr><th>Market</th><th class="r">Shares</th><th class="r">Avg</th><th class="r">Value</th><th class="r">P&L</th></tr></thead>
        <tbody>{pos.data.map((p) => <tr><td>{p.title} <span class="muted small">{p.outcome}</span></td><td class="r">{qty(p.size)}</td><td class="r">{cents(p.avgPrice)}</td><td class="r">{usd(p.value)}</td><td class={`r ${p.pnl >= 0 ? "up" : "down"}`}>{usd(p.pnl)}</td></tr>)}</tbody></table>}
    </section>
  );
}

/** Checks price alerts every minute while the Predict screen is open. */
function useAlertWatcher() {
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      const alerts = getState().prefs.predictionAlerts;
      if (!alerts.length) return;
      const prices = new Map<string, number>();
      const events = [...new Map(alerts.map((a) => [`${a.venue}:${a.eventId}`, a])).values()];
      for (const a of events) {
        const ev = await fetchEvent(a.venue, a.eventId).catch(() => null);
        ev?.outcomes.forEach((o) => prices.set(`${ev.venue}:${o.id}`, o.price));
      }
      if (stopped) return;
      const hit = triggeredAlerts(alerts, prices);
      if (!hit.length) return;
      for (const a of hit) {
        const msg = `${a.eventTitle}${a.label && a.label !== a.eventTitle ? ` · ${a.label}` : ""} is ${a.above ? "up to" : "down to"} ${pct(prices.get(`${a.venue}:${a.outcomeId}`)!)}.`;
        toast(msg);
        if ("Notification" in window && Notification.permission === "granted") new Notification("$FIRM Wallet price alert", { body: msg, icon: "/icon.svg" });
      }
      await savePrefs({ predictionAlerts: getState().prefs.predictionAlerts.filter((a) => !hit.includes(a)) });
    };
    check();
    const id = setInterval(check, 60_000);
    return () => { stopped = true; clearInterval(id); };
  }, []);
}
