import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import { CHAINS, type ChainKey, type NetworkMode } from "../core/config.ts";
import { errorText, getState, requestApproval, toast, touch, useStore } from "./store.ts";
import { execute, waitFor, type PreparedEvmTx } from "../core/evm.ts";
import { confirm, sendSigned, type PreparedSolTx } from "../core/solana.ts";
import { submit, type PreparedPerpOrder } from "../core/perps.ts";

export function Field(props: { label: string; children: ComponentChildren; hint?: string }) {
  return (
    <div class="field">
      <label>{props.label}</label>
      {props.children}
      {props.hint && <span class="small muted">{props.hint}</span>}
    </div>
  );
}

export function Seg<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="seg" role="tablist">
      {props.options.map((o) => (
        <button type="button" role="tab" aria-selected={o.value === props.value} class={o.value === props.value ? "on" : ""} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [text]);
  return <div class="qr" aria-label={`QR code for ${text}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  return (
    <button class="btn ghost" type="button" onClick={async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast("Copied.");
      } catch {
        toast("Couldn't copy. Select and copy it instead.", "err");
      }
    }}>{label}</button>
  );
}

export function usd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: n < 1 ? 4 : 2 });
}

export function num(n: number, max = 6): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? max : 4 });
}

export function pct(p: number, digits = 0): string {
  return `${(p * 100).toFixed(digits)}%`;
}

export function Prob({ p }: { p: number }) {
  return <div class="prob" role="meter" aria-valuenow={Math.round(p * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.round(p * 100)}%` }} /></div>;
}

export function txUrl(mode: NetworkMode, chain: ChainKey, hash: string): string {
  const c = CHAINS[mode][chain];
  return chain === "solana" ? `${c.explorer}/tx/${hash}${mode === "testnet" ? "?cluster=devnet" : ""}` : `${c.explorer}/tx/${hash}`;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error?: string; loading: boolean; reload: () => void } {
  const [n, setN] = useState(0);
  const [s, setS] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    setS((p) => ({ ...p, loading: true, error: undefined }));
    fn().then(
      (data) => live && setS({ data, loading: false }),
      (e) => live && setS({ error: errorText(e), loading: false }),
    );
    return () => void (live = false);
  }, [...deps, n]);
  return { ...s, reload: () => setN((x) => x + 1) };
}

/** Show the approval sheet for each step, then sign and send. Returns tx hashes / signatures. */
export async function approveAndSend(steps: (PreparedEvmTx | PreparedSolTx)[]): Promise<string[]> {
  const st = getState();
  if (!st.session) throw new Error("Unlock the wallet first.");
  const hashes: string[] = [];
  for (const [i, tx] of steps.entries()) {
    const ok = await requestApproval({
      title: steps.length > 1 ? `${tx.title} (step ${i + 1} of ${steps.length})` : tx.title,
      details: tx.details,
      confirmLabel: "Approve and sign",
      warning: tx.mode === "mainnet" ? "Mainnet: this moves real funds and can't be undone." : undefined,
    });
    if (!ok) throw new Error("Cancelled.");
    touch();
    if (tx.chain === "solana") {
      const sig = await sendSigned(tx.mode, await (tx as PreparedSolTx).build(st.session.sol));
      toast("Sent. Waiting for confirmation…");
      await confirm(tx.mode, sig);
      hashes.push(sig);
    } else {
      const evm = tx as PreparedEvmTx;
      const hash = await execute(st.session.evm, evm);
      toast("Sent. Waiting for confirmation…");
      const receipt = await waitFor(evm.mode, evm.chain, hash);
      if (receipt.status !== "success") throw new Error("The transaction failed on chain.");
      hashes.push(hash);
    }
  }
  return hashes;
}

export async function approveAndSubmitPerp(mode: NetworkMode, order: PreparedPerpOrder, warning: string | undefined = "Perpetual futures are leveraged. Prices can move against you fast."): Promise<void> {
  const st = getState();
  if (!st.session) throw new Error("Unlock the wallet first.");
  const ok = await requestApproval({ title: order.title, details: order.details, confirmLabel: "Approve and sign", warning: warning || undefined });
  if (!ok) throw new Error("Cancelled.");
  await submit(mode, st.session.evm, order);
}

export function ApprovalSheet() {
  const { approval } = useStore();
  useEffect(() => {
    if (!approval) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && approval.resolve(false);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [approval]);
  if (!approval) return null;
  return (
    <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="approve-title">
      <div class="sheet stack">
        <p class="eyebrow">Review before you sign</p>
        <h2 id="approve-title">{approval.title}</h2>
        <dl class="kv">
          {approval.details.map(([k, v]) => [<dt>{k}</dt>, <dd class={/^0x|^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? "mono" : ""}>{v}</dd>])}
        </dl>
        {approval.warning && <p class="warn">{approval.warning}</p>}
        <div class="grid two">
          <button class="btn block" type="button" onClick={() => approval.resolve(false)}>Cancel</button>
          <button class="btn solid block" type="button" onClick={() => approval.resolve(true)}>{approval.confirmLabel ?? "Approve"}</button>
        </div>
      </div>
    </div>
  );
}

export function Toast() {
  const { toast: t } = useStore();
  return t ? <div class={`toast ${t.kind === "err" ? "err" : ""}`} role="status" aria-live="polite">{t.text}</div> : null;
}
