/**
 * A small bridge to Telegram's Mini App host, written from Telegram's published protocol
 * (core.telegram.org/api/web-events), so no outside script is loaded and the CSP stays 'self'.
 *
 * - Telegram opens the page with launch data in the URL hash (#tgWebAppPlatform=…&tgWebAppThemeParams=…).
 * - Messages to Telegram: TelegramWebviewProxy.postEvent on phones and desktop, postMessage to
 *   web.telegram.org when the page is framed by Telegram Web.
 * - Messages from Telegram: window.Telegram.WebView.receiveEvent, or postMessage from web.telegram.org.
 *
 * The wallet never trusts anything Telegram sends for keys or money: only looks (theme), the
 * native buttons and haptics. Keys stay in this page's own encrypted vault.
 */

export const TELEGRAM_WEB_ORIGINS = ["https://web.telegram.org"];

export interface LaunchParams {
  platform?: string;
  version?: string;
  theme: Record<string, string>;
}

const STORE_KEY = "firm-mini-launch";

/** Read Telegram's launch parameters from a URL hash (keeps working after the hash changes, via sessionStorage). */
export function parseLaunchParams(hash: string): LaunchParams | null {
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  if (!q.has("tgWebAppPlatform") && !q.has("tgWebAppData")) return null;
  let theme: Record<string, string> = {};
  try {
    theme = JSON.parse(q.get("tgWebAppThemeParams") ?? "{}");
  } catch {
    theme = {};
  }
  return { platform: q.get("tgWebAppPlatform") ?? undefined, version: q.get("tgWebAppVersion") ?? undefined, theme };
}

function loadLaunch(): LaunchParams | null {
  if (typeof location === "undefined") return null;
  const fresh = parseLaunchParams(location.hash);
  try {
    if (fresh) sessionStorage.setItem(STORE_KEY, JSON.stringify(fresh));
    else {
      const saved = sessionStorage.getItem(STORE_KEY);
      if (saved) return JSON.parse(saved) as LaunchParams;
    }
  } catch {
    /* storage blocked: fine */
  }
  return fresh;
}

export const launch = loadLaunch();
export const inTelegram = !!launch;

type W = Window & {
  TelegramWebviewProxy?: { postEvent(type: string, data: string): void };
  Telegram?: { WebView?: { receiveEvent?: (type: string, data: unknown) => void } };
};

export function postEvent(type: string, data: unknown = ""): void {
  if (!inTelegram) return;
  const w = window as W;
  try {
    if (w.TelegramWebviewProxy?.postEvent) w.TelegramWebviewProxy.postEvent(type, JSON.stringify(data));
    else if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType: type, eventData: data }), TELEGRAM_WEB_ORIGINS[0]!);
  } catch {
    /* host went away */
  }
}

type Handler = (data: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

function dispatch(type: string, data: unknown) {
  handlers.get(type)?.forEach((h) => h(data));
}

if (inTelegram && typeof window !== "undefined") {
  const w = window as W;
  w.Telegram = { ...w.Telegram, WebView: { ...w.Telegram?.WebView, receiveEvent: dispatch } };
  addEventListener("message", (e) => {
    if (!TELEGRAM_WEB_ORIGINS.includes(e.origin)) return;
    try {
      const msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      if (msg && typeof msg.eventType === "string") dispatch(msg.eventType, msg.eventData);
    } catch {
      /* not for us */
    }
  });
}

export function on(type: string, h: Handler): () => void {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type)!.add(h);
  return () => handlers.get(type)?.delete(h);
}

const isHex = (s: unknown): s is string => typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** Telegram's theme colours → the wallet's CSS tokens. Only valid #rrggbb values are used. */
export function themeVars(theme: Record<string, string>): { vars: Record<string, string>; dark: boolean } | null {
  if (!isHex(theme.bg_color) || !isHex(theme.text_color)) return null;
  const vars: Record<string, string> = { "--paper": theme.bg_color, "--ink": theme.text_color };
  if (isHex(theme.hint_color)) vars["--ink-3"] = vars["--ink-2"] = theme.hint_color;
  if (isHex(theme.secondary_bg_color)) vars["--wash"] = theme.secondary_bg_color;
  if (isHex(theme.section_separator_color)) vars["--line"] = theme.section_separator_color;
  return { vars, dark: luminance(theme.bg_color) < 0.4 };
}

export function applyTheme(theme: Record<string, string>): void {
  const t = themeVars(theme);
  if (!t) return;
  const root = document.documentElement;
  root.dataset.theme = t.dark ? "dark" : "light";
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(k, v);
}

export function haptic(kind: "success" | "error" | "tap"): void {
  if (kind === "tap") postEvent("web_app_trigger_haptic_feedback", { type: "impact", impact_style: "light" });
  else postEvent("web_app_trigger_haptic_feedback", { type: "notification", notification_type: kind });
}

/** Native bottom button. Pass null to hide it. */
export function setMainButton(btn: { text: string; active: boolean; progress?: boolean } | null): void {
  postEvent("web_app_setup_main_button", btn
    ? { is_visible: true, is_active: btn.active, is_progress_visible: !!btn.progress, text: btn.text.slice(0, 64) }
    : { is_visible: false });
}

export function setBackButton(visible: boolean): void {
  postEvent("web_app_setup_back_button", { is_visible: visible });
}

/** Ask before closing while the wallet is unlocked, so a swipe doesn't drop a half-made trade. */
export function setClosingConfirmation(need: boolean): void {
  postEvent("web_app_setup_closing_behavior", { need_confirmation: need });
}

export function start(): void {
  if (!inTelegram) return;
  document.documentElement.classList.add("tg");
  applyTheme(launch!.theme);
  on("theme_changed", (d) => applyTheme(((d as { theme_params?: Record<string, string> })?.theme_params) ?? {}));
  postEvent("web_app_ready");
  postEvent("web_app_expand");
  postEvent("web_app_request_theme");
}
