import { useState } from "preact/hooks";
import { isAddress } from "viem";
import { CHAINS, type ChainKey, type TokenInfo } from "../../core/config.ts";
import { isSolanaAddress } from "../../core/keys.ts";
import { kvDelete, removeDeviceVault, unseal } from "../../core/vault.ts";
import { DataSharingCard, DeviceUnlockCard, InstallCard } from "../cards.tsx";
import { errorText, lock, requestApproval, savePrefs, toast, useStore } from "../store.ts";
import { Copy, Field, Seg } from "../kit.tsx";

export function SettingsScreen() {
  const { prefs, session, vault } = useStore();
  const [reveal, setReveal] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [tok, setTok] = useState<{ chain: ChainKey; address: string; symbol: string; decimals: string }>({ chain: "base", address: "", symbol: "", decimals: "18" });

  return (
    <div class="stack">
      <p class="eyebrow">Settings</p>
      <h1>Settings</h1>
      <div class="grid two">
        <section class="card stack">
          <h3>Network</h3>
          <Seg value={prefs.mode} options={[{ value: "testnet", label: "Testnet" }, { value: "mainnet", label: "Mainnet" }]} onChange={async (m) => {
            if (m === "mainnet") {
              const ok = await requestApproval({ title: "Switch to mainnet", details: [["Networks", "Ethereum, Base, Arbitrum and Solana mainnet"], ["Funds", "Real. Transactions can't be undone."]], warning: "This build hasn't had an external security audit yet. Keep only what you can afford to lose.", confirmLabel: "Use mainnet" });
              if (!ok) return;
            }
            await savePrefs({ mode: m });
          }} />
          <p class="small muted">Testnet uses Sepolia, Base Sepolia, Arbitrum Sepolia and Solana Devnet: free test coins, no real value.</p>
          <Field label="Swap slippage limit">
            <select value={String(prefs.slippageBps)} onChange={(e) => savePrefs({ slippageBps: Number((e.target as HTMLSelectElement).value) })}>
              {[10, 50, 100, 300].map((b) => <option value={String(b)}>{(b / 100).toFixed(1)}%</option>)}
            </select>
          </Field>
          <Field label="Auto-lock">
            <select value={String(prefs.autoLockMinutes)} onChange={(e) => savePrefs({ autoLockMinutes: Number((e.target as HTMLSelectElement).value) })}>
              {[1, 5, 10, 30].map((m) => <option value={String(m)}>After {m} minute{m === 1 ? "" : "s"} idle</option>)}
            </select>
          </Field>
          {prefs.marketsAcknowledged && <button class="btn ghost" onClick={() => savePrefs({ marketsAcknowledged: false })}>Hide stocks, perps and options again</button>}
        </section>

        <section class="card stack">
          <h3>Your addresses</h3>
          <p class="small muted">Ethereum, Base and Arbitrum</p>
          <div class="row between"><span class="mono">{session!.evm.address}</span><Copy text={session!.evm.address} /></div>
          <p class="small muted">Solana</p>
          <div class="row between"><span class="mono">{session!.sol.address}</span><Copy text={session!.sol.address} /></div>
        </section>

        <DeviceUnlockCard />
        <InstallCard />

        <section class="card stack">
          <h3>Recovery phrase</h3>
          <p class="small muted">Shown only after you enter your password. Never share it. Infinitum will never ask for it.</p>
          {reveal ? (
            <>
              <div class="words">{reveal.split(" ").map((w) => <span>{w}</span>)}</div>
              <button class="btn block" onClick={() => setReveal(null)}>Hide</button>
            </>
          ) : (
            <form class="row" onSubmit={async (e) => {
              e.preventDefault();
              try {
                setReveal(await unseal(vault!, pw));
              } catch (x) {
                toast(errorText(x), "err");
              } finally {
                setPw("");
              }
            }}>
              <input type="password" autocomplete="current-password" placeholder="Password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} style={{ flex: 1, minHeight: 42, border: "1px solid var(--line)", padding: "0 12px", background: "var(--paper)" }} />
              <button class="btn" type="submit" disabled={!pw}>Show</button>
            </form>
          )}
        </section>

        <section class="card stack">
          <h3>Add a token</h3>
          <Seg value={tok.chain} options={(["ethereum", "base", "arbitrum", "solana"] as ChainKey[]).map((c) => ({ value: c, label: CHAINS[prefs.mode][c].name }))} onChange={(chain) => setTok({ ...tok, chain })} />
          <Field label={tok.chain === "solana" ? "Mint address" : "Contract address"}><input class="mono" value={tok.address} onInput={(e) => setTok({ ...tok, address: (e.target as HTMLInputElement).value.trim() })} /></Field>
          <div class="grid two">
            <Field label="Symbol"><input value={tok.symbol} maxLength={12} onInput={(e) => setTok({ ...tok, symbol: (e.target as HTMLInputElement).value.trim() })} /></Field>
            <Field label="Decimals"><input inputMode="numeric" value={tok.decimals} onInput={(e) => setTok({ ...tok, decimals: (e.target as HTMLInputElement).value })} /></Field>
          </div>
          <button class="btn" disabled={!tok.symbol || !(tok.chain === "solana" ? isSolanaAddress(tok.address) : isAddress(tok.address))} onClick={async () => {
            const t: TokenInfo = { chain: tok.chain, symbol: tok.symbol, name: tok.symbol, decimals: Number(tok.decimals) || 0, address: tok.address };
            await savePrefs({ customTokens: [...prefs.customTokens.filter((x) => !(x.chain === t.chain && x.address === t.address)), t] });
            toast(`Added ${t.symbol}.`);
            setTok({ ...tok, address: "", symbol: "" });
          }}>Add token</button>
          {prefs.customTokens.map((t) => (
            <div class="row between small"><span>{t.symbol} · {t.chain} · <span class="mono">{t.address}</span></span>
              <button class="btn ghost" onClick={() => savePrefs({ customTokens: prefs.customTokens.filter((x) => x !== t) })}>Remove</button></div>
          ))}
        </section>

        <DataSharingCard />

        <section class="card stack">
          <h3>Lock and remove</h3>
          <button class="btn block" onClick={lock}>Lock now</button>
          <button class="btn danger block" onClick={async () => {
            const ok = await requestApproval({ title: "Remove this wallet from this device", details: [["What's deleted", "The encrypted wallet on this device and its settings"], ["Your funds", "Stay on chain. Restore them with your recovery phrase."]], warning: "Without your recovery phrase you can't get back in. Make sure you have it first.", confirmLabel: "Remove from this device" });
            if (!ok) return;
            await kvDelete("vault");
            await removeDeviceVault();
            await kvDelete("prefs");
            lock();
            location.reload();
          }}>Remove wallet from this device</button>
        </section>
      </div>
      <p class="small muted">Free, open-source building blocks: viem, @scure and @noble cryptography, Preact. Prices from Hyperliquid and GeckoTerminal. Swaps through Uniswap V2 and Jupiter. Perps on Hyperliquid, options data from Derive. Infinitum adds no fees.</p>
    </div>
  );
}
