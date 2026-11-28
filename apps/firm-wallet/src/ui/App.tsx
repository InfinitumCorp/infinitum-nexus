import { useEffect, useState } from "preact/hooks";
import { boot, touch, useStore } from "./store.ts";
import { ApprovalSheet, Toast } from "./kit.tsx";
import { Onboarding, Unlock } from "./screens/Onboarding.tsx";
import { WalletScreen } from "./screens/Wallet.tsx";
import { SwapScreen } from "./screens/Swap.tsx";
import { MarketsScreen } from "./screens/Markets.tsx";
import { PerpsScreen } from "./screens/Perps.tsx";
import { OptionsScreen } from "./screens/Options.tsx";
import { PredictScreen } from "./screens/Predict.tsx";
import { RewardsScreen } from "./screens/Rewards.tsx";
import { NexusRequestCard, NexusScreen, useNexusRequest } from "./screens/Nexus.tsx";
import { SettingsScreen } from "./screens/Settings.tsx";

const TABS = [
  ["wallet", "Wallet"], ["swap", "Swap"], ["markets", "Markets"], ["perps", "Perps"], ["options", "Options"],
  ["predict", "Predict"], ["rewards", "Rewards"], ["nexus", "Connections"], ["settings", "Settings"],
] as const;
type Tab = (typeof TABS)[number][0];

/** Loads the Cumulus://ID account bar (public/cumulus-bar.js, a vendored copy: the CSP allows only 'self'). */
function loadAccountBar() {
  if (document.getElementById("cumulus-bar-js")) return;
  const s = document.createElement("script");
  s.id = "cumulus-bar-js";
  s.src = "/cumulus-bar.js";
  s.dataset.client = "firm-wallet";
  document.body.append(s);
}

function routeFromHash(): Tab {
  const name = location.hash.replace(/^#\//, "").split("?")[0] as Tab;
  return TABS.some(([t]) => t === name) ? name : "wallet";
}

export function App() {
  const st = useStore();
  const [tab, setTab] = useState<Tab>(routeFromHash);
  const [nexusReq, clearNexus] = useNexusRequest();

  useEffect(() => void boot(), []);
  useEffect(() => {
    const onHash = () => setTab(routeFromHash());
    addEventListener("hashchange", onHash);
    const activity = () => touch();
    addEventListener("pointerdown", activity);
    addEventListener("keydown", activity);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("pointerdown", activity);
      removeEventListener("keydown", activity);
    };
  }, []);

  // The Cumulus://ID account bar in the header, once the header is on the page.
  useEffect(() => { if (st.ready) loadAccountBar(); }, [st.ready]);

  if (!st.ready) return <div class="center"><p class="muted">Loading…</p></div>;

  const header = (
    <header class="top">
      <div class="wrap bar">
        <a class="wordmark" href="#/wallet" style={{ textDecoration: "none" }}>$FIRM Wallet<span class="tm">™</span></a>
        <div class="bar-end">
          {st.session && <span class={`mode ${st.prefs.mode === "mainnet" ? "live" : ""}`}>{st.prefs.mode === "mainnet" ? "Mainnet" : "Testnet"}</span>}
          <div data-cumulus-bar data-create="false" />
        </div>
      </div>
      {st.session && !nexusReq && (
        <div class="wrap">
          <nav class="tabs" aria-label="Sections">
            {TABS.map(([t, label]) => <a href={`#/${t}`} class={t === tab ? "on" : ""} aria-current={t === tab ? "page" : undefined}>{label}</a>)}
          </nav>
        </div>
      )}
    </header>
  );

  let body;
  if (!st.vault) body = <Onboarding />;
  else if (!st.session) body = <Unlock />;
  else if (nexusReq) body = <div class="center"><NexusRequestCard req={nexusReq} onDone={clearNexus} /></div>;
  else body = {
    wallet: <WalletScreen />, swap: <SwapScreen />, markets: <MarketsScreen />, perps: <PerpsScreen />, options: <OptionsScreen />, predict: <PredictScreen />,
    rewards: <RewardsScreen />, nexus: <NexusScreen />, settings: <SettingsScreen />,
  }[tab];

  return (
    <>
      {header}
      <main><div class="wrap">{body}</div></main>
      <footer class="footer"><div class="wrap">Self-custody: your keys stay on this device. Infinitum Corporation never holds your funds. Military editions stay outside the token economy.</div></footer>
      <ApprovalSheet />
      <Toast />
    </>
  );
}
