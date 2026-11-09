import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { leverageSteps, parseTickers, withMids, prepareSpotOrder, ticketSummary, usdTransferTypedData, type Ticker } from "../src/core/dex.ts";
import { roundPrice } from "../src/core/perps.ts";
import { parseLaunchParams, themeVars } from "../src/mini/telegram.ts";
import { SECURITY_HEADERS, securityHeadersFor } from "../worker/api.ts";

const perp = [
  { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "OLD", szDecimals: 0, maxLeverage: 3, isDelisted: true }, { name: "HYPE", szDecimals: 2, maxLeverage: 10 }] },
  [{ midPx: "75856.5", prevDayPx: "75000", dayNtlVlm: "571586643.9", funding: "0.0000125" }, { midPx: null }, { midPx: "76.5", prevDayPx: "80", dayNtlVlm: "1000" }],
] as Parameters<typeof parseTickers>[0];
const spot = [
  {
    tokens: [{ name: "USDC", szDecimals: 8, index: 0 }, { name: "PURR", szDecimals: 0, index: 1 }, { name: "HYPE", szDecimals: 2, index: 150 }, { name: "USDT0", szDecimals: 2, index: 268 }],
    universe: [{ name: "PURR/USDC", tokens: [1, 0], index: 0 }, { name: "@107", tokens: [150, 0], index: 107 }, { name: "@999", tokens: [150, 268], index: 999 }],
  },
  [{ coin: "@107", midPx: "76.5725", prevDayPx: "75", dayNtlVlm: "27888191" }, { coin: "PURR/USDC", midPx: "0.096552", prevDayPx: "0.1", dayNtlVlm: "492246" }, { coin: "@999", midPx: "76" }],
] as Parameters<typeof parseTickers>[1];

describe("Hyperliquid tickers for the mini app", () => {
  const list = parseTickers(perp, spot);

  it("lists live perps by position and USDC spot pairs by coin name", () => {
    expect(list.map((t) => `${t.kind}:${t.label}:${t.asset}`)).toEqual(["perp:BTC:0", "perp:HYPE:2", "spot:PURR/USDC:10000", "spot:HYPE/USDC:10107"]);
    const btc = list[0]!;
    expect(btc.change24h).toBeCloseTo(75856.5 / 75000 - 1);
    expect(btc.funding).toBeCloseTo(0.0000125);
    expect(list[3]).toMatchObject({ coin: "@107", base: "HYPE", szDecimals: 2, maxLeverage: 1 });
  });

  it("refreshes prices from allMids without refetching the lists", () => {
    const next = withMids(list, { BTC: "76500", "@107": "80", HYPE: "garbage" });
    expect(next[0]!.mid).toBe(76500);
    expect(next[0]!.change24h).toBeCloseTo(76500 / 75000 - 1);
    expect(next[3]!.change24h).toBeCloseTo(80 / 75 - 1);
    expect(next[1]!.mid).toBe(76.5);
  });

  it("rounds spot prices to 5 significant figures and 8 − szDecimals decimals", () => {
    expect(roundPrice(0.0965523, 0, 8)).toBe("0.096552");
    expect(roundPrice(77.34123, 2, 8)).toBe("77.341");
    expect(roundPrice(0.000012345678, 0, 8)).toBe("0.00001235");
    expect(roundPrice(0.0965523, 0)).toBe("0.096552");
  });

  it("builds spot buys from dollars and sells from the balance, rounding size down", () => {
    const hype = list[3]!;
    const buy = prepareSpotOrder({ ticker: hype, side: "buy", usd: 25 });
    expect(buy.actions).toEqual([{ type: "order", orders: [{ a: 10107, b: true, p: "77.338", s: "0.32", r: false, t: { limit: { tif: "Ioc" } } }], grouping: "na" }]);
    const sell = prepareSpotOrder({ ticker: hype, side: "sell", size: 0.3999 });
    expect((sell.actions[0] as { orders: { s: string; b: boolean }[] }).orders[0]).toMatchObject({ s: "0.39", b: false });
    expect(() => prepareSpotOrder({ ticker: hype, side: "buy", usd: 5 })).toThrow(/minimum/);
    expect(() => prepareSpotOrder({ ticker: list[0]!, side: "buy", usd: 50 })).toThrow(/spot/);
  });

  it("offers leverage within the market's and the wallet's caps", () => {
    expect(leverageSteps(40)).toEqual([1, 2, 3, 5, 10]);
    expect(leverageSteps(3)).toEqual([1, 2, 3]);
    expect(ticketSummary(list[0]! as Ticker, "long", 100, 5)).toMatch(/^Margin ≈ \$20\.00 · liq\. ≈ /);
  });

  it("signs the perps ⇄ spot transfer like Hyperliquid's SDK", async () => {
    const { action, typed } = usdTransferTypedData("mainnet", 12.5, false, 1_700_000_000_000);
    expect(action).toEqual({ type: "usdClassTransfer", amount: "12.5", toPerp: false, nonce: 1_700_000_000_000, signatureChainId: "0x66eee", hyperliquidChain: "Mainnet" });
    expect(typed.domain).toMatchObject({ name: "HyperliquidSignTransaction", chainId: 421614 });
    expect(usdTransferTypedData("testnet", 1, true, 1).action.hyperliquidChain).toBe("Testnet");
    const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const sig = await acct.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature: sig })).toBe(acct.address);
  });
});

describe("Telegram Mini App bridge", () => {
  it("reads Telegram's launch parameters from the hash", () => {
    const theme = encodeURIComponent(JSON.stringify({ bg_color: "#17212b", text_color: "#f5f5f5", hint_color: "#708499" }));
    const p = parseLaunchParams(`#tgWebAppData=x&tgWebAppVersion=8.0&tgWebAppPlatform=ios&tgWebAppThemeParams=${theme}`);
    expect(p).toEqual({ platform: "ios", version: "8.0", theme: { bg_color: "#17212b", text_color: "#f5f5f5", hint_color: "#708499" } });
    expect(parseLaunchParams("#/perps")).toBeNull();
    expect(parseLaunchParams("#tgWebAppPlatform=web&tgWebAppThemeParams=%7Bbad")?.theme).toEqual({});
  });

  it("maps only valid theme colours and detects dark themes", () => {
    expect(themeVars({ bg_color: "#17212b", text_color: "#f5f5f5", hint_color: "#708499" })).toEqual({
      vars: { "--paper": "#17212b", "--ink": "#f5f5f5", "--ink-2": "#708499", "--ink-3": "#708499" }, dark: true,
    });
    expect(themeVars({ bg_color: "#ffffff", text_color: "#000000" })?.dark).toBe(false);
    expect(themeVars({ bg_color: "red; background:url(x)", text_color: "#000000" })).toBeNull();
  });
});

describe("Worker framing rules", () => {
  it("lets Telegram Web frame the mini page and nothing else", () => {
    const mini = securityHeadersFor("/mini");
    expect(mini["content-security-policy"]).toContain("frame-ancestors 'self' https://web.telegram.org");
    expect(mini["x-frame-options"]).toBeUndefined();
    expect(securityHeadersFor("/")).toBe(SECURITY_HEADERS);
    expect(securityHeadersFor("/mini-evil")["x-frame-options"]).toBe("DENY");
    expect(SECURITY_HEADERS["content-security-policy"]).toContain("frame-ancestors 'none'");
  });
});
