/**
 * VEIL Nexus: the free-tier Infinitum products connected in the signed-in
 * workspace, and the account summary every product shares.
 *
 * Nothing here is reachable from the anonymous workspace.
 */
import { VEIL_DEV } from "./build.js";

/** Production hosts. Stored overrides cannot replace these. */
export const PINNED_ORIGINS = Object.freeze({
  scalvs: "https://scalvs.app",
  architect: "https://cndctr.app",
  veil: "https://infinitumveil.app",
});

/** Where each product runs. `cid` and `mail` still accept a stored http(s) origin. */
export const DEFAULT_ORIGINS = Object.freeze({
  cid: "http://localhost:3000",      // +SPCTR server hosts Cumulus://ID sign-in today
  mail: "http://localhost:3010",     // apps/cumulus-mail
  architect: PINNED_ORIGINS.architect,
  scalvs: PINNED_ORIGINS.scalvs,
  veil: PINNED_ORIGINS.veil, // VEIL browser control plane, hosted on Cloudflare
});

/**
 * Free-tier products, in the order the product page lists them.
 * `origin` names a key in DEFAULT_ORIGINS; `panel` opens a VEIL panel instead;
 * neither means the product has no client yet.
 */
export const APPS = Object.freeze([
  { id: "cid", name: "Cumulus://ID", blurb: "Your account and permissions", origin: "cid" },
  { id: "mail", name: "Cumulus://Mail", blurb: "Free email at you@cumulusmail.cloud", origin: "mail" },
  { id: "cloud", name: "Cumulus://Cloud", blurb: "15 GB of Drive storage and a free cloud tier" },
  { id: "scalvs", name: "SCALVS.ai", blurb: "Free AI agents beside every page", origin: "scalvs" },
  { id: "architect", name: ":\\ARCHITECT\\", blurb: "Turn a page, an email or an idea into finished work", origin: "architect" },
  { id: "metatron", name: "METATRON¹⁰⁰", blurb: "The open-source dashboard for everything you follow" },
  { id: "wallet", name: "FIRM Wallet", blurb: "Hold, send and swap every Infinitum token", panel: "wallet" },
]);

/** Only plain http(s) URLs are ever opened or fetched. */
export function safeOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Dev packages may point SCALVS, CNDCTR, or VEIL at this machine. No other host is accepted. */
export function isDevLoopback(origin) {
  const safe = safeOrigin(origin);
  if (!safe) return false;
  const host = new URL(safe).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

export function resolveOrigins(stored, options = {}) {
  const dev = options.dev ?? VEIL_DEV;
  const out = { ...DEFAULT_ORIGINS };
  for (const key of Object.keys(DEFAULT_ORIGINS)) {
    const o = safeOrigin(stored?.[key]);
    if (!o) continue;
    if (Object.hasOwn(PINNED_ORIGINS, key)) {
      if (dev && isDevLoopback(o)) out[key] = o;
      continue;
    }
    out[key] = o;
  }
  return out;
}

/**
 * Normalize an account summary. Accepts both the +SPCTR `/api/me` shape
 * ({ cid, username, mailAddress, cumulus: {...} }) and the Cumulus::Mail
 * `/api/me` shape (the Cumulus summary itself). Unknown fields are dropped.
 * @returns {object | null}
 */
export function parseSummary(me) {
  if (!me || typeof me !== "object" || typeof me.cid !== "string" || !me.cid) return null;
  const c = me.cumulus && typeof me.cumulus === "object" ? me.cumulus : me;
  const str = (v, max = 200) => (typeof v === "string" ? v.slice(0, max) : null);
  const num = (v) => (Number.isFinite(v) ? v : null);
  const balances = {};
  if (c.wallet?.balances && typeof c.wallet.balances === "object") {
    for (const [asset, amount] of Object.entries(c.wallet.balances)) {
      if (/^[A-Z$]{2,10}$/.test(asset) && typeof amount === "string" && /^\d+(\.\d+)?$/.test(amount)) {
        balances[asset] = amount;
      }
    }
  }
  return {
    cid: me.cid.slice(0, 120),
    username: str(me.username, 80),
    mailAddress: str(me.mailAddress, 200),
    plan: str(c.plan, 40),
    mail: c.mail ? { unread: Math.max(0, Math.floor(num(c.mail.unread) ?? 0)), url: safeOrigin(c.mail.url) } : null,
    storage: c.storage ? { label: str(c.storage.label, 80), pct: Math.min(100, Math.max(0, num(c.storage.pct) ?? 0)) } : null,
    wallet: c.wallet ? { address: str(c.wallet.address, 120), balances } : null,
  };
}

/**
 * Launcher entries for the signed-in workspace.
 * @returns {{ id, name, blurb, url: string|null, panel: string|null, badge: number }[]}
 */
export function launcher(origins, summary) {
  return APPS.map((app) => {
    let url = app.origin ? origins[app.origin] ?? null : null;
    if (app.id === "mail" && summary?.mail?.url) url = summary.mail.url;
    let blurb = app.blurb;
    if (app.id === "mail" && summary?.mailAddress) blurb = summary.mailAddress;
    if (app.id === "cloud" && summary?.storage?.label) blurb = `${blurb} · ${summary.storage.label}`;
    return {
      id: app.id,
      name: app.name,
      blurb,
      url,
      panel: app.panel ?? null,
      badge: app.id === "mail" ? summary?.mail?.unread ?? 0 : 0,
    };
  });
}

/** Toolbar badge text for unread mail ("" hides it). */
export function badgeText(unread) {
  if (!Number.isFinite(unread) || unread <= 0) return "";
  return unread > 99 ? "99+" : String(Math.floor(unread));
}
