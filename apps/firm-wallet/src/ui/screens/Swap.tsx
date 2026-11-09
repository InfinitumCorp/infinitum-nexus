import { useEffect, useState } from "preact/hooks";
import { formatUnits, type Address } from "viem";
import { CHAINS, tokensFor, usdcAddress, type ChainKey, type TokenInfo } from "../../core/config.ts";
import { prepareSwap, quoteEvm, trim, type EvmQuote } from "../../core/evm.ts";
import { mintInfo, parseUnitsBig, prepareJupiterSwap, quoteJupiter, WSOL_MINT, type JupQuote } from "../../core/solana.ts";
import { discoverStocks } from "../../core/stocks.ts";
import { errorText, toast, useStore } from "../store.ts";
import { approveAndSend, Field, Seg, useAsync } from "../kit.tsx";

export interface SwapPrefill {
  chain: ChainKey;
  from?: string;
  to?: string;
  amount?: string;
}
let prefill: SwapPrefill | null = null;
export function openSwap(p: SwapPrefill) {
  prefill = p;
  location.hash = "#/swap";
}

const SWAP_CHAINS: { value: ChainKey; label: string }[] = [
  { value: "base", label: "Base" }, { value: "ethereum", label: "Ethereum" }, { value: "solana", label: "Solana" },
];

export function SwapScreen() {
  const { session, prefs } = useStore();
  const [init] = useState(() => {
    const p = prefill;
    prefill = null;
    return p;
  });
  const [chain, setChain] = useState<ChainKey>(init?.chain ?? "base");
  const stocks = useAsync(() => (chain === "solana" && prefs.mode === "mainnet" && prefs.marketsAcknowledged ? discoverStocks() : Promise.resolve([])), [chain, prefs.mode, prefs.marketsAcknowledged]);
  const tokens: TokenInfo[] = [...tokensFor(prefs.mode, chain, prefs.customTokens), ...(stocks.data ?? [])]
    .filter((t) => !t.infinitum || t.address)
    .filter((t) => !(chain === "solana" && t.symbol === "wSOL"));
  const [from, setFrom] = useState(init?.from ?? CHAINS[prefs.mode][chain].nativeSymbol);
  const [to, setTo] = useState(init?.to ?? "USDC");
  const [amount, setAmount] = useState(init?.amount ?? "");
  const [quote, setQuote] = useState<{ evm?: EvmQuote; jup?: JupQuote; outText: string; route: string; inDec: number; outDec: number } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const tin = tokens.find((t) => t.symbol === from);
  const tout = tokens.find((t) => t.symbol === to);

  useEffect(() => setQuote(null), [chain, from, to, amount, prefs.mode]);

  const getQuote = async () => {
    if (!tin || !tout || tin.symbol === tout.symbol) return;
    setBusy(true);
    setErr("");
    try {
      if (chain === "solana") {
        const inMint = tin.address ?? WSOL_MINT;
        const outMint = tout.address ?? WSOL_MINT;
        const [mi, mo] = await Promise.all([inMint === WSOL_MINT ? { decimals: 9 } : mintInfo(prefs.mode, inMint), outMint === WSOL_MINT ? { decimals: 9 } : mintInfo(prefs.mode, outMint)]);
        const jup = await quoteJupiter(prefs.mode, inMint, outMint, parseUnitsBig(amount, mi.decimals), prefs.slippageBps);
        setQuote({ jup, outText: trim(formatUnits(BigInt(jup.outAmount), mo.decimals)), route: "Jupiter", inDec: mi.decimals, outDec: mo.decimals });
      } else {
        const list = tokensFor(prefs.mode, chain);
        const firm = list.find((t) => t.symbol === "FIRM" && t.address);
        const hubs = [...(firm ? [{ symbol: "FIRM", address: firm.address as Address }] : []), { symbol: "USDC", address: usdcAddress(prefs.mode, chain) as Address }];
        const evm = await quoteEvm(prefs.mode, chain, tin, tout, amount, prefs.slippageBps, hubs);
        setQuote({ evm, outText: trim(formatUnits(evm.amountOut, tout.decimals)), route: evm.route, inDec: tin.decimals, outDec: tout.decimals });
      }
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const doSwap = async () => {
    if (!quote || !tin || !tout) return;
    setBusy(true);
    try {
      const steps = quote.jup
        ? [prepareJupiterSwap(prefs.mode, session!.sol.address, quote.jup, tin, tout, quote.inDec, quote.outDec)]
        : await prepareSwap(prefs.mode, chain, session!.evm.address, quote.evm!, tin, tout);
      await approveAndSend(steps);
      toast(`Swapped ${tin.symbol} for ${tout.symbol}.`);
      setQuote(null);
      setAmount("");
    } catch (e) {
      if (errorText(e) !== "Cancelled.") toast(errorText(e), "err");
    } finally {
      setBusy(false);
    }
  };

  const options = tokens.map((t) => <option value={t.symbol}>{t.symbol}{t.category === "stock" ? " (stock)" : t.category === "wrapped" ? " (wrapped)" : ""} · {t.name}</option>);

  return (
    <div class="grid two">
      <section class="card ink stack">
        <p class="eyebrow">Infinitum Nexus™ swap</p>
        <h2>Swap</h2>
        <Seg value={chain} options={SWAP_CHAINS} onChange={(c) => { setChain(c); setFrom(CHAINS[prefs.mode][c].nativeSymbol); setTo("USDC"); }} />
        <Field label="You pay"><select value={from} onChange={(e) => setFrom((e.target as HTMLSelectElement).value)}>{options}</select></Field>
        <Field label="Amount"><input inputMode="decimal" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value.replace(",", "."))} /></Field>
        <button class="btn ghost" type="button" onClick={() => { setFrom(to); setTo(from); }}>⇅ Flip</button>
        <Field label="You get"><select value={to} onChange={(e) => setTo((e.target as HTMLSelectElement).value)}>{options}</select></Field>
        {quote && <p class="note">≈ <b>{quote.outText} {to}</b> via {quote.route}. Slippage limit {(prefs.slippageBps / 100).toFixed(2)}%.</p>}
        {err && <p class="warn">{err}</p>}
        {!quote
          ? <button class="btn solid block" disabled={busy || !amount || from === to} onClick={getQuote}>{busy ? "Finding the best route…" : "Get quote"}</button>
          : <button class="btn solid block" disabled={busy} onClick={doSwap}>{busy ? "Working…" : "Review swap"}</button>}
      </section>
      <section class="card stack small">
        <h3>How swaps route</h3>
        <p class="muted">Every Infinitum product token pairs with $FIRM™ and USDC, so any token converts to any other. On Ethereum and Base the wallet checks the direct pool, the $FIRM™ route and the USDC route on Uniswap V2 and takes whichever gives you more. On Solana it uses Jupiter, which also covers wrapped SOL, cbBTC and tokenized stocks.</p>
        <p class="muted">Infinitum adds no fee. You pay the pool's fee and the network fee, both shown before you sign.</p>
        {chain === "solana" && !prefs.marketsAcknowledged && <p class="note">Tokenized stocks appear here after you confirm the venue terms in Markets.</p>}
        {stocks.error && <p class="small down">Couldn't load tokenized stocks: {stocks.error}</p>}
        {(stocks.data?.length ?? 0) > 0 && <p class="muted">{stocks.data!.length} tokenized stocks available (xStocks).</p>}
      </section>
    </div>
  );
}
