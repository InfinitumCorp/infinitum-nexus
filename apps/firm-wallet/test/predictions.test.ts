import { describe, expect, it } from "vitest";
import {
  buyQuote, cryptoThreshold, displayPrice, eventsFromMarkets, eventTitle, guessCategory, thresholdChance, fromGamma, fromKalshi, kalshiBook, kalshiHistory, matchesQuery, polymarketOutcomes, similarEvents,
  triggeredAlerts, type PredictionEvent,
} from "../src/core/predictions.ts";
import { handleApi, trimKalshiEvents, trimKalshiMarkets } from "../worker/api.ts";

describe("prediction market prices", () => {
  it("shows the midpoint when the spread is tight, else the last trade", () => {
    expect(displayPrice(0.51, 0.52, 0.4)).toBeCloseTo(0.515);
    expect(displayPrice(0.2, 0.6, 0.35)).toBe(0.35);
    expect(displayPrice(undefined, undefined, 0.7)).toBe(0.7);
  });

  it("reads Polymarket yes/no and head-to-head markets", () => {
    const yesNo = polymarketOutcomes([{ id: "1", question: "Will X?", groupItemTitle: "X", outcomes: '["Yes","No"]', outcomePrices: '["0.3","0.7"]', clobTokenIds: '["tY","tN"]', bestBid: 0.29, bestAsk: 0.31, oneDayPriceChange: 0.02 }]);
    expect(yesNo).toEqual([{ id: "tY", label: "X", price: 0.3, bid: 0.29, ask: 0.31, change24h: 0.02, volume24h: undefined }]);
    const h2h = polymarketOutcomes([{ id: "2", question: "Giants vs. Eagles", outcomes: '["Giants","Eagles"]', outcomePrices: '["0.515","0.485"]', clobTokenIds: '["g","e"]', bestBid: 0.51, bestAsk: 0.52, lastTradePrice: 0.52, oneDayPriceChange: -0.09 }]);
    expect(h2h.map((o) => o.label)).toEqual(["Giants", "Eagles"]);
    expect(h2h[1]).toMatchObject({ id: "e", bid: 0.48, ask: 0.49, change24h: 0.09 });
    expect(h2h[1]!.price).toBeCloseTo(0.485);
    expect(polymarketOutcomes([{ id: "3", question: "Closed", closed: true, clobTokenIds: '["a"]' }])).toEqual([]);
  });

  it("builds a Polymarket event with a venue link", () => {
    const e = fromGamma({ id: "9", slug: "fed-dec", title: "Fed decision", volume24hr: 10, markets: [{ id: "1", question: "Cut?", outcomes: '["Yes","No"]', outcomePrices: '["0.6","0.4"]', clobTokenIds: '["t1","t2"]' }] });
    expect(e).toMatchObject({ venue: "polymarket", url: "https://polymarket.com/event/fed-dec", volume24h: 10 });
  });

  it("reads Kalshi events and their 24h change", () => {
    const e = fromKalshi({
      event_ticker: "KXELONMARS-99", series_ticker: "KXELONMARS", title: "Elon on Mars?", category: "Science and Technology",
      markets: [{ ticker: "KXELONMARS-99", title: "Before 2099?", yes_sub_title: "Mars", status: "active", close_time: "2099-08-01T04:59:00Z", yes_bid_dollars: "0.1000", yes_ask_dollars: "0.1100", last_price_dollars: "0.1000", previous_price_dollars: "0.1100", volume_24h_fp: "57.44" }],
    })!;
    expect(e.url).toBe("https://kalshi.com/markets/kxelonmars");
    expect(e.outcomes[0]).toMatchObject({ id: "KXELONMARS-99", label: "Mars", series: "KXELONMARS" });
    expect(e.outcomes[0]!.price).toBeCloseTo(0.105);
    expect(e.outcomes[0]!.change24h).toBeCloseTo(-0.01);
    expect(e.volume24h).toBeCloseTo(57.44);
  });

  it("turns Kalshi's no-bids into yes-asks", () => {
    const b = kalshiBook([["0.0600", "2237.98"], ["0.1000", "17.90"]], [["0.8500", "50.00"], ["0.8900", "4.00"]]);
    expect(b.bids[0]).toEqual({ price: 0.1, size: 17.9 });
    expect(b.asks[0]).toEqual({ price: 0.11, size: 4 });
    expect(b.asks[1]).toEqual({ price: 0.15, size: 50 });
  });

  it("charts Kalshi candles from trades, else the bid/ask middle", () => {
    expect(kalshiHistory([
      { end_period_ts: 10, price: { close_dollars: "0.08" } },
      { end_period_ts: 20, price: { close_dollars: null }, yes_bid: { close_dollars: "0.08" }, yes_ask: { close_dollars: "0.10" } },
      { end_period_ts: 30 },
    ])).toEqual([{ t: 10_000, p: 0.08 }, { t: 20_000, p: 0.09 }]);
  });
});

describe("prediction market math", () => {
  it("quotes payouts; Kalshi's taker fee is 7% × C × P × (1 − P), rounded up", () => {
    const poly = buyQuote("polymarket", 0.25, 100);
    expect(poly).toMatchObject({ shares: 400, payout: 400, profit: 300, fee: 0 });
    const k = buyQuote("kalshi", 0.5, 100);
    // 194 contracts: $97 + fee ceil(0.07 × 194 × 0.25) = $3.40 → $100.40, over budget; 193: $96.50 + $3.38 = $99.88.
    expect(k.shares).toBe(193);
    expect(k.fee).toBeCloseTo(3.38);
    expect(k.shares * 0.5 + k.fee).toBeLessThanOrEqual(100);
    expect(buyQuote("kalshi", 0, 100).shares).toBe(0);
  });

  it("finds the same question on the other venue", () => {
    const ev = (venue: "polymarket" | "kalshi", id: string, title: string): PredictionEvent => ({ venue, id, title, volume24h: 0, url: "", outcomes: [{ id, label: "Yes", price: 0.5 }] });
    const poly = ev("polymarket", "p", "Fed decision in December 2026?");
    const matches = similarEvents(poly, [ev("kalshi", "k1", "Fed decision in December"), ev("kalshi", "k2", "Who will win the Super Bowl?"), ev("polymarket", "p2", "Fed decision in December 2026?")]);
    expect(matches.map((m) => m.event.id)).toEqual(["k1"]);
  });

  it("searches Kalshi titles ignoring plurals and partial words", () => {
    expect(matchesQuery("Fed funds rate at end of 2036", "Fed rates")).toBe(true);
    expect(matchesQuery("Who will win the election?", "elect")).toBe(true);
    expect(matchesQuery("US unemployment rate", "Fed rates")).toBe(false);
    expect(matchesQuery("Bitcoin price today", "bitcoin")).toBe(true);
  });

  it("fires alerts only when the condition is met", () => {
    const a = { venue: "kalshi" as const, eventId: "E", outcomeId: "M", label: "", eventTitle: "E", above: true, price: 0.6 };
    const b = { ...a, outcomeId: "N", above: false, price: 0.2 };
    expect(triggeredAlerts([a, b], new Map([["kalshi:M", 0.61], ["kalshi:N", 0.25]]))).toEqual([a]);
  });

  it("spots crypto price questions Conjure can price", () => {
    expect(cryptoThreshold("Bitcoin above ___ on February 23?", "100,000")).toEqual({ coin: "BTC", strike: 100_000, above: true, touch: false });
    expect(cryptoThreshold("What price will Ethereum hit in November?", "↓ 2,000")).toEqual({ coin: "ETH", strike: 2000, above: false, touch: true });
    expect(cryptoThreshold("Will Solana reach $300 by 2027?", "Yes")).toEqual({ coin: "SOL", strike: 300, above: true, touch: true });
  });

  it("prices touch questions at about twice the end-of-period chance", () => {
    const hit = { coin: "BTC" as const, strike: 100_000, above: true, touch: true };
    expect(thresholdChance(hit, 75_000, 0.05)).toBeCloseTo(0.1);
    expect(thresholdChance(hit, 101_000, 0.6)).toBe(1);
    expect(thresholdChance({ ...hit, above: false, strike: 70_000 }, 75_000, 0.8)).toBeCloseTo(0.4);
    expect(thresholdChance({ ...hit, touch: false }, 75_000, 0.05)).toBe(0.05);
    expect(cryptoThreshold("Bitcoin price range on Friday?", "$100,000 to 101,999")).toBeNull();
    expect(cryptoThreshold("Giants vs. Eagles", "Giants")).toBeNull();
  });
});

describe("Kalshi relay", () => {
  it("forwards only allow-listed public GETs, naming the client", async () => {
    const seen: { url: string; ua: string | null }[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, ua: new Headers(init?.headers).get("user-agent") });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const get = (p: string, method = "GET") => handleApi(new Request(`https://w.test/api/kalshi/${p}`, { method }), {});
      expect((await get("events?status=open&limit=200"))!.status).toBe(200);
      expect((await get("markets/KXELONMARS-99/orderbook?depth=8"))!.status).toBe(200);
      expect((await get("series/KXELONMARS/markets/KXELONMARS-99/candlesticks?period_interval=60"))!.status).toBe(200);
      expect((await get("portfolio/balance"))!.status).toBe(404);
      expect((await get("markets/../portfolio"))!.status).toBe(404);
      expect((await get("events", "POST"))!.status).toBe(405);
      expect(seen.map((s) => s.url)).toEqual([
        "https://api.elections.kalshi.com/trade-api/v2/events?status=open&limit=200",
        "https://api.elections.kalshi.com/trade-api/v2/markets/KXELONMARS-99/orderbook?depth=8",
        "https://api.elections.kalshi.com/trade-api/v2/series/KXELONMARS/markets/KXELONMARS-99/candlesticks?period_interval=60",
      ]);
      expect(seen[0]!.ua).toMatch(/^InfinitumFirmWallet\//);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("sports and list size", () => {
  it("shows who wins for a game, not its hundreds of side markets", () => {
    const side = (q: string, type: string, tok: string) => ({ id: tok, question: q, groupItemTitle: q, sportsMarketType: type, outcomes: '["Over","Under"]', outcomePrices: '["0.5","0.5"]', clobTokenIds: `["${tok}o","${tok}u"]` });
    const out = polymarketOutcomes([
      { id: "m", question: "Giants vs. Eagles", sportsMarketType: "moneyline", outcomes: '["Giants","Eagles"]', outcomePrices: '["0.4","0.6"]', clobTokenIds: '["g","e"]' },
      side("O/U 44.5", "totals", "t1"), side("O/U 45.5", "totals", "t2"),
    ]);
    expect(out.map((o) => o.label)).toEqual(["Eagles", "Giants"]);
    // Without a moneyline, side markets are labelled by their question.
    expect(polymarketOutcomes([side("O/U 44.5", "totals", "t1"), side("O/U 45.5", "totals", "t2")]).map((o) => o.label)).toContain("O/U 44.5 · Over");
  });

  it("trims Kalshi event lists to what the list shows", () => {
    const body = JSON.stringify({ cursor: "c", events: [{ event_ticker: "E", settlement_sources: [{ url: "x" }], markets: [{ ticker: "M", yes_bid_dollars: "0.1", rules_primary: "long text", custom_strike: { a: 1 } }] }] });
    expect(JSON.parse(trimKalshiEvents(body))).toEqual({ cursor: "c", events: [{ event_ticker: "E", markets: [{ ticker: "M", yes_bid_dollars: "0.1" }] }] });
    expect(trimKalshiEvents("not json")).toBe("not json");
  });
});

describe("Kalshi markets closing this week", () => {
  const m = (ticker: string, event_ticker: string, title: string, yes: string, rules = "") => ({ ticker, event_ticker, title, yes_sub_title: yes, status: "active", yes_bid_dollars: "0.40", yes_ask_dollars: "0.42", volume_24h_fp: "100", rules_primary: rules });

  it("names games, fields and single questions", () => {
    const rules = "If Turkiye wins the Turkiye vs Belgium professional UEFA Nations League soccer game originally scheduled";
    expect(eventTitle([m("A", "E", "Turkiye wins", "Turkiye", rules), m("B", "E", "Belgium wins", "Belgium", rules)])).toBe("Turkiye vs Belgium");
    expect(eventTitle([m("A", "E", "Will Zane Smith be the NASCAR Cup Series Champion?", "Zane Smith"), m("B", "E", "Will William Byron be the NASCAR Cup Series Champion?", "William Byron")])).toBe("Will ___ be the NASCAR Cup Series Champion?");
    expect(eventTitle([m("A", "E", "Will it snow in NYC?", "Yes")])).toBe("Will it snow in NYC?");
  });

  it("groups markets into events, skipping combos, and files them by series", () => {
    const evs = eventsFromMarkets([
      m("KXNFLGAME-26NOV12WASNYG-WAS", "KXNFLGAME-26NOV12WASNYG", "Washington wins", "Washington", "If Washington wins the Washington vs New York G Pro Football game"),
      m("KXNFLGAME-26NOV12WASNYG-NYG", "KXNFLGAME-26NOV12WASNYG", "New York G wins", "New York G", "If New York G wins the Washington vs New York G Pro Football game"),
      m("KXMVECROSS-1", "KXMVECROSS-1", "combo", "combo"),
    ]);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ id: "KXNFLGAME-26NOV12WASNYG", title: "Washington vs New York G", category: "Sports", url: "https://kalshi.com/markets/kxnflgame" });
    expect(evs[0]!.outcomes[0]!.series).toBe("KXNFLGAME");
    expect(guessCategory("KXBTCD")).toBe("Crypto");
    expect(guessCategory("KXFEDDECISION")).toBe("Economics");
  });

  it("trims market lists but keeps what names games", () => {
    const out = JSON.parse(trimKalshiMarkets(JSON.stringify({ markets: [{ ticker: "M", event_ticker: "E", rules_primary: "x".repeat(500), price_ranges: [1] }] })));
    expect(out.markets[0]).toEqual({ ticker: "M", event_ticker: "E", rules_primary: "x".repeat(200) });
  });
});

describe("Kalshi event names from market titles", () => {
  const m = (title: string, yes: string, rules = "") => ({ ticker: yes, event_ticker: "E", title, yes_sub_title: yes, status: "active", rules_primary: rules });
  it("finds the game even when the first market is the tie", () => {
    expect(eventTitle([
      m("Tie is the result", "Tie", "If Tie is the result of the Italy vs France professional UEFA Nations League soccer game"),
      m("Italy wins", "Italy", "If Italy wins the Italy vs France professional UEFA Nations League soccer game"),
    ])).toBe("Italy vs France");
  });
  it("blanks out where the titles differ", () => {
    expect(eventTitle([
      m("Will Donald Trump make below 60 Truth Social posts the week of Nov 8, 2026?", "<60"),
      m("Will Donald Trump make at least 220 Truth Social posts the week of Nov 8, 2026?", "220+"),
    ])).toBe("Will Donald Trump make ___ Truth Social posts the week of Nov 8, 2026?");
    expect(eventTitle([m("Will Kyle Larson be the NASCAR Cup Series Champion?", "Kyle Larson"), m("Will Zane Smith be the NASCAR Cup Series Champion?", "Z. Smith")]))
      .toBe("Will ___ be the NASCAR Cup Series Champion?");
    expect(eventTitle([m("Alpha", "A"), m("Beta", "B")])).toBe("Alpha");
  });
});
