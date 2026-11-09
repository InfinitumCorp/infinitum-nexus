/** Settings cards shared by the full wallet and $FIRM Mini: device unlock, install, data exchange. */
import { useEffect, useState } from "preact/hooks";
import { NEXUS_PRODUCTS } from "../core/config.ts";
import { DATA_SHARE_PERSON_PCT, DATA_SHARE_POOL_MIN, gpcEnabled, NEVER_SOLD, offeredProducts } from "../core/data-sharing.ts";
import { deviceUnlockAvailable, enableDeviceUnlock } from "../core/device-unlock.ts";
import { removeDeviceVault, saveDeviceVault, unseal } from "../core/vault.ts";
import { errorText, savePrefs, setDeviceVault, toast, useStore } from "./store.ts";
import { useInstall } from "./install.ts";

const inputStyle = { flex: 1, minHeight: 42, border: "1px solid var(--line)", padding: "0 12px", background: "var(--paper)", color: "var(--ink)" };

export function DeviceUnlockCard() {
  const { vault, deviceVault } = useStore();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => void deviceUnlockAvailable().then(setAvailable), []);

  return (
    <section class="card stack">
      <h3>Unlock with fingerprint or face</h3>
      <p class="small muted">
        A passkey on this device, kept in its secure hardware, unlocks the wallet after a fingerprint, face or screen-lock check.
        Nothing is sent anywhere, and your password keeps working.
      </p>
      {deviceVault ? (
        <>
          <p class="small">On for this device since {new Date(deviceVault.createdAt).toLocaleDateString()}.</p>
          <button class="btn block" type="button" onClick={async () => {
            await removeDeviceVault();
            setDeviceVault(null);
            toast("Fingerprint and face unlock are off. The passkey can be deleted in your phone's password settings.");
          }}>Turn off</button>
        </>
      ) : available === false ? (
        <p class="small muted">This browser can't do it here (it needs a phone or computer with a fingerprint, face or PIN unlock, opened in its own browser rather than inside another app).</p>
      ) : (
        <form class="row" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const phrase = await unseal(vault!, pw);
            const dv = await enableDeviceUnlock(phrase);
            await saveDeviceVault(dv);
            setDeviceVault(dv);
            toast("Done. Next time, unlock with your fingerprint or face.");
          } catch (x) {
            if (errorText(x) !== "Cancelled.") toast(errorText(x), "err");
          } finally {
            setPw("");
            setBusy(false);
          }
        }}>
          <input type="password" autocomplete="current-password" placeholder="Password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} style={inputStyle} />
          <button class="btn" type="submit" disabled={busy || !pw || available === null}>{busy ? "Waiting…" : "Turn on"}</button>
        </form>
      )}
    </section>
  );
}

export function InstallCard() {
  const { kind, install } = useInstall();
  if (!kind) return null;
  return (
    <section class="card stack">
      <h3>Install the app</h3>
      {kind === "prompt" ? (
        <>
          <p class="small muted">Adds $FIRM Wallet™ to your home screen. It opens full screen, works offline and updates itself.</p>
          <button class="btn solid block" type="button" onClick={install}>Install</button>
        </>
      ) : (
        <p class="small muted">On iPhone: tap Share in Safari, then "Add to Home Screen".</p>
      )}
    </section>
  );
}

export function DataSharingCard() {
  const { prefs } = useStore();
  const gpc = gpcEnabled();
  const products = offeredProducts(NEXUS_PRODUCTS.filter((p) => !p.hosts.includes(p.id)));
  return (
    <section class="card stack">
      <p class="eyebrow">Data exchange · opt-in · in development</p>
      <h3>Your data, your share</h3>
      <p class="small muted">
        Choose, product by product, whether de-identified usage data may be pooled with at least {DATA_SHARE_POOL_MIN.toLocaleString()} other people.
        You keep {DATA_SHARE_PERSON_PCT}% of eligible net revenue, paid in product tokens and recorded on $Firmament Network™.
        Nothing is shared yet: your choices stay on this device until the exchange opens.
      </p>
      {gpc && <p class="note">Your browser sends Global Privacy Control, so you're opted out of every product.</p>}
      {products.map((p) => (
        <label class="row between">
          <span>{p.name}</span>
          <input type="checkbox" disabled={gpc} checked={!gpc && prefs.dataSharing[p.id] === true}
            onChange={(e) => savePrefs({ dataSharing: { ...prefs.dataSharing, [p.id]: (e.target as HTMLInputElement).checked } })} />
        </label>
      ))}
      <p class="small muted">Never sold: {NEVER_SOLD.join(", ")}. You can opt out of any sale at any time.</p>
    </section>
  );
}
