/**
 * App state: the unlocked session (keys in memory only, wiped on lock), preferences saved on the
 * device, and the one approval queue every transaction goes through.
 */
import { useEffect, useState } from "preact/hooks";
import type { HDAccount } from "viem/accounts";
import { DEFAULT_MODE, type NetworkMode, type TokenInfo } from "../core/config.ts";
import { evmAccount, solanaKeypair, type SolanaKeypair } from "../core/keys.ts";
import { kvGet, kvSet, loadDeviceVault, loadVault, type DeviceVault, type SealedVault } from "../core/vault.ts";
import type { Connection } from "../core/connect.ts";
import type { PriceAlert, WatchedEvent } from "../core/predictions.ts";

export interface Prefs {
  mode: NetworkMode;
  /** Confirmed on this device that venue terms allow stocks, perps and options. */
  marketsAcknowledged: boolean;
  connections: Connection[];
  customTokens: TokenInfo[];
  autoLockMinutes: number;
  slippageBps: number;
  /** Prediction-market events starred on this device. */
  predictionWatch: WatchedEvent[];
  /** Price alerts on prediction-market outcomes, checked while the Predict screen is open. */
  predictionAlerts: PriceAlert[];
  /** Data exchange opt-ins by product id (all off unless chosen; GPC overrides). */
  dataSharing: Record<string, boolean>;
}

const DEFAULT_PREFS: Prefs = {
  mode: DEFAULT_MODE, marketsAcknowledged: false, connections: [], customTokens: [], autoLockMinutes: 10, slippageBps: 50,
  predictionWatch: [], predictionAlerts: [], dataSharing: {},
};

export interface Session {
  evm: HDAccount;
  sol: SolanaKeypair;
}

export interface ApprovalRequest {
  title: string;
  details: [string, string][];
  warning?: string;
  confirmLabel?: string;
}

interface State {
  ready: boolean;
  vault: SealedVault | null;
  /** Fingerprint / face unlock for this device, if turned on. */
  deviceVault: DeviceVault | null;
  session: Session | null;
  prefs: Prefs;
  approval: (ApprovalRequest & { resolve: (ok: boolean) => void }) | null;
  toast: { text: string; kind: "ok" | "err" } | null;
}

let state: State = { ready: false, vault: null, deviceVault: null, session: null, prefs: DEFAULT_PREFS, approval: null, toast: null };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function getState(): State {
  return state;
}

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  emit();
}

export function useStore(): State {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return state;
}

export async function boot() {
  const [vault, device, prefs] = await Promise.all([
    loadVault().catch(() => undefined), loadDeviceVault().catch(() => undefined), kvGet<Prefs>("prefs").catch(() => undefined),
  ]);
  set({ ready: true, vault: vault ?? null, deviceVault: device ?? null, prefs: { ...DEFAULT_PREFS, ...prefs } });
}

export async function savePrefs(patch: Partial<Prefs>) {
  const prefs = { ...state.prefs, ...patch };
  set({ prefs });
  await kvSet("prefs", prefs);
}

export function setVault(vault: SealedVault) {
  set({ vault });
}

export function setDeviceVault(deviceVault: DeviceVault | null) {
  set({ deviceVault });
}

let lockTimer: ReturnType<typeof setTimeout> | undefined;

export function unlockWith(phrase: string) {
  set({ session: { evm: evmAccount(phrase), sol: solanaKeypair(phrase) } });
  touch();
}

export function lock() {
  const s = state.session;
  if (s) s.sol.secret.fill(0);
  clearTimeout(lockTimer);
  set({ session: null, approval: null });
}

/** Any interaction pushes the auto-lock back. */
export function touch() {
  clearTimeout(lockTimer);
  if (state.session) lockTimer = setTimeout(lock, state.prefs.autoLockMinutes * 60_000);
}

export function requestApproval(req: ApprovalRequest): Promise<boolean> {
  return new Promise((resolve) => {
    set({ approval: { ...req, resolve: (ok) => { set({ approval: null }); resolve(ok); } } });
  });
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string, kind: "ok" | "err" = "ok") {
  clearTimeout(toastTimer);
  set({ toast: { text, kind } });
  toastTimer = setTimeout(() => set({ toast: null }), 6000);
}

export function errorText(e: unknown): string {
  const m = e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : String(e);
  if (/insufficient funds/i.test(m)) return "Not enough balance to cover this and the network fee.";
  if (/user rejected/i.test(m)) return "Cancelled.";
  return m.length > 220 ? `${m.slice(0, 220)}…` : m;
}
