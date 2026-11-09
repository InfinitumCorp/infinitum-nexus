import { useState } from "preact/hooks";
import type { Address } from "viem";
import { CHAINS, tokensFor, type ChainKey, type TokenInfo } from "../../core/config.ts";
import { prepareSend, prepareWrap } from "../../core/evm.ts";
import { prepareSolSend } from "../../core/solana.ts";
import { errorText, toast, useStore } from "../store.ts";
import { loadPortfolio, type ChainPortfolio, type Holding } from "../data.ts";
import { approveAndSend, Copy, Field, num, Qr, Seg, txUrl, usd, useAsync } from "../kit.tsx";

type Panel = { kind: "send"; chain: ChainKey; token?: TokenInfo; to?: string; amount?: string; memo?: string; onDone?: (hash: string) => void } | { kind: "receive"; chain: ChainKey } | { kind: "wrap"; chain: ChainKey } | null;

/** Opened from a VEIL Nexus pay request. */
let pendingPanel: Panel = null;
export function openSend(p: Exclude<Panel, null>) {
  pendingPanel = p;
  location.hash = "#/wallet";
}

export function WalletScreen() {
  const { session, prefs } = useStore();
  const [panel, setPanel] = useState<Panel>(() => {
    const p = pendingPanel;
    pendingPanel = null;
    return p;
  });
  const pf = useAsync(() => loadPortfolio(prefs.mode, session!, prefs.customTokens), [prefs.mode, session?.evm.address]);
  const total = pf.data?.flatMap((c) => c.holdings).reduce((s, h) => s + (h.usd ?? 0), 0) ?? 0;

  return (
    <div class="stack">
      <p class="eyebrow">Total balance · {prefs.mode === "mainnet" ? "Mainnet" : "Testnet"}</p>
      <div class="total">{pf.loading && !pf.data ? "…" : usd(total)}</div>
      <div class="row wrapflex">
        <button class="btn solid" onClick={() => setPanel({ kind: "send", chain: "base" })}>Send</button>
        <button class="btn" onClick={() => setPanel({ kind: "receive", chain: "base" })}>Receive</button>
        <a class="btn" href="#/swap">Swap</a>
        <button class="btn" onClick={() => setPanel({ kind: "wrap", chain: "base" })}>Wrap / unwrap</button>
        <button class="btn ghost" onClick={pf.reload} disabled={pf.loading}>{pf.loading ? "Refreshing…" : "Refresh"}</button>
      </div>
      {prefs.mode === "testnet" && <p class="note">Testnet: balances aren't real money. Get free test ETH from a Sepolia or Base Sepolia faucet and test SOL with <span class="mono">solana airdrop</span>. Switch to mainnet in Settings.</p>}
      {pf.error && <p class="warn">{pf.error}</p>}
      {panel?.kind === "send" && <SendPanel {...panel} portfolio={pf.data} onClose={() => setPanel(null)} onSent={pf.reload} />}
      {panel?.kind === "receive" && <ReceivePanel chain={panel.chain} onClose={() => setPanel(null)} />}
      {panel?.kind === "wrap" && <WrapPanel chain={panel.chain} portfolio={pf.data} onClose={() => setPanel(null)} onDone={pf.reload} />}
      <div class="grid two">
        {(pf.data ?? []).map((c) => <ChainCard c={c} onSend={(token) => setPanel({ kind: "send", chain: c.chain, token })} />)}
      </div>
    </div>
  );
}

function Glyph({ t }: { t: TokenInfo & { icon?: string } }) {
  return <div class="glyph">{t.icon ? <img src={t.icon} alt="" loading="lazy" referrerpolicy="no-referrer" /> : t.symbol.slice(0, 4)}</div>;
}

function ChainCard({ c, onSend }: { c: ChainPortfolio; onSend: (t: TokenInfo) => void }) {
  return (
    <section class="card">
      <div class="row between"><h3>{c.name}</h3><span class="small muted mono">{short(c.address)}</span></div>
      {c.error && <p class="small down">Couldn't load: {c.error}</p>}
      {c.holdings.map((h) => <HoldingRow h={h} onSend={() => onSend(h.token)} />)}
    </section>
  );
}

function HoldingRow({ h, onSend }: { h: Holding; onSend: () => void }) {
  const t = h.token;
  return (
    <div class="asset">
      <Glyph t={t} />
      <div class="name">
        <div>{t.symbol}{t.category === "wrapped" && <span class="tag">Wrapped</span>}{t.category === "stock" && <span class="tag">Stock</span>}{t.infinitum && <span class="tag">Infinitum</span>}</div>
        <div class="small muted">{t.name}{t.product ? ` · ${t.product}` : ""}</div>
      </div>
      <div class="amt">
        <div>{num(h.amount)}</div>
        <div class="small muted">{usd(h.usd)}</div>
      </div>
      <button class="btn ghost" aria-label={`Send ${t.symbol}`} onClick={onSend} disabled={h.raw === 0n}>Send</button>
    </div>
  );
}

export function short(a: string) {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

const CHAIN_OPTIONS = (["ethereum", "base", "solana", "arbitrum"] as ChainKey[]).map((k) => ({ value: k, label: k === "ethereum" ? "Ethereum" : k[0]!.toUpperCase() + k.slice(1) }));

function SendPanel(p: { chain: ChainKey; token?: TokenInfo; to?: string; amount?: string; memo?: string; onDone?: (h: string) => void; portfolio?: ChainPortfolio[]; onClose: () => void; onSent: () => void }) {
  const { session, prefs } = useStore();
  const [chain, setChain] = useState<ChainKey>(p.chain);
  const holdings = p.portfolio?.find((c) => c.chain === chain)?.holdings ?? [];
  const sendable = holdings.filter((h) => h.token.address || !h.token.infinitum);
  const [symbol, setSymbol] = useState(p.token?.symbol ?? sendable[0]?.token.symbol ?? CHAINS[prefs.mode][chain].nativeSymbol);
  const [to, setTo] = useState(p.to ?? "");
  const [amount, setAmount] = useState(p.amount ?? "");
  const [busy, setBusy] = useState(false);
  const token = holdings.find((h) => h.token.symbol === symbol)?.token ?? tokensFor(prefs.mode, chain).find((t) => t.symbol === symbol);
  const balance = holdings.find((h) => h.token.symbol === symbol);

  const send = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const tx = chain === "solana"
        ? await prepareSolSend(prefs.mode, session!.sol.address, token, to.trim(), amount)
        : await prepareSend(prefs.mode, chain, session!.evm.address, token, to.trim(), amount);
      if (p.memo) tx.details.unshift(["Memo", p.memo]);
      const [hash] = await approveAndSend([tx]);
      toast("Sent and confirmed.");
      p.onDone?.(hash!);
      p.onSent();
      p.onClose();
      window.open(txUrl(prefs.mode, chain, hash!), "_blank", "noopener");
    } catch (e) {
      if (errorText(e) !== "Cancelled.") toast(errorText(e), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class="card ink stack">
      <div class="row between"><h2>Send</h2><button class="btn ghost" onClick={p.onClose}>Close</button></div>
      <Seg value={chain} options={CHAIN_OPTIONS} onChange={(c) => { setChain(c); setSymbol(CHAINS[prefs.mode][c].nativeSymbol); }} />
      <Field label="Asset">
        <select value={symbol} onChange={(e) => setSymbol((e.target as HTMLSelectElement).value)}>
          {sendable.map((h) => <option value={h.token.symbol}>{h.token.symbol} · {num(h.amount)}</option>)}
        </select>
      </Field>
      <Field label="To" hint={chain === "solana" ? "A Solana address." : "An 0x address. Double-check it: sends can't be reversed."}>
        <input class="mono" autocomplete="off" spellcheck={false} value={to} onInput={(e) => setTo((e.target as HTMLInputElement).value)} />
      </Field>
      <Field label="Amount" hint={balance ? `Available: ${num(balance.amount)} ${symbol}` : undefined}>
        <input inputMode="decimal" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value.replace(",", "."))} />
      </Field>
      <button class="btn solid block" disabled={busy || !to || !amount || !token} onClick={send}>{busy ? "Working…" : "Review"}</button>
    </section>
  );
}

function ReceivePanel({ chain: initial, onClose }: { chain: ChainKey; onClose: () => void }) {
  const { session } = useStore();
  const [chain, setChain] = useState<ChainKey>(initial);
  const address = chain === "solana" ? session!.sol.address : session!.evm.address;
  return (
    <section class="card ink stack">
      <div class="row between"><h2>Receive</h2><button class="btn ghost" onClick={onClose}>Close</button></div>
      <Seg value={chain} options={CHAIN_OPTIONS} onChange={setChain} />
      <div class="row wrapflex" style={{ alignItems: "flex-start" }}>
        <Qr text={address} />
        <div class="stack" style={{ flex: 1, minWidth: 220 }}>
          <p class="mono">{address}</p>
          <Copy text={address} label="Copy address" />
          <p class="small muted">{chain === "solana" ? "For SOL and Solana tokens (SPL), including tokenized stocks." : "The same address works on Ethereum, Base and Arbitrum for ETH and ERC-20 tokens. Make sure the sender uses the network you expect."}</p>
        </div>
      </div>
    </section>
  );
}

function WrapPanel({ chain: initial, portfolio, onClose, onDone }: { chain: ChainKey; portfolio?: ChainPortfolio[]; onClose: () => void; onDone: () => void }) {
  const { session, prefs } = useStore();
  const evmChains = CHAIN_OPTIONS.filter((c) => c.value !== "solana");
  const [chain, setChain] = useState<ChainKey>(initial === "solana" ? "base" : initial);
  const [dir, setDir] = useState<"wrap" | "unwrap">("wrap");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const weth = tokensFor(prefs.mode, chain).find((t) => t.symbol === "WETH");
  const hold = portfolio?.find((c) => c.chain === chain)?.holdings ?? [];
  const avail = hold.find((h) => h.token.symbol === (dir === "wrap" ? "ETH" : "WETH"))?.amount;
  return (
    <section class="card ink stack">
      <div class="row between"><h2>Wrap and unwrap</h2><button class="btn ghost" onClick={onClose}>Close</button></div>
      <p class="small muted">WETH is ETH as an ERC-20 token, 1:1, minted and redeemed by the WETH contract with no fee. On Solana, SOL is wrapped and unwrapped automatically when you swap. BTC on Ethereum, Base and Solana comes wrapped as WBTC or cbBTC: get it with Swap.</p>
      <Seg value={chain} options={evmChains} onChange={setChain} />
      <Seg value={dir} options={[{ value: "wrap", label: "ETH → WETH" }, { value: "unwrap", label: "WETH → ETH" }]} onChange={setDir} />
      <Field label="Amount" hint={avail !== undefined ? `Available: ${num(avail)}` : undefined}>
        <input inputMode="decimal" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value.replace(",", "."))} />
      </Field>
      <button class="btn solid block" disabled={busy || !amount || !weth} onClick={async () => {
        setBusy(true);
        try {
          await approveAndSend([await prepareWrap(prefs.mode, chain, session!.evm.address as Address, weth!, amount, dir)]);
          toast(dir === "wrap" ? "Wrapped." : "Unwrapped.");
          onDone();
          onClose();
        } catch (e) {
          if (errorText(e) !== "Cancelled.") toast(errorText(e), "err");
        } finally {
          setBusy(false);
        }
      }}>{busy ? "Working…" : "Review"}</button>
    </section>
  );
}
