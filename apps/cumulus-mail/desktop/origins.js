// Where the app connects, and the pure helpers main.js uses (kept here so they can be tested without Electron).

/** Cumulus://Mail itself. The app always tries this first and needs nothing else. */
const PRIMARY = "https://mail.cumuluscloud.app";
/**
 * Optional mirror for networks that throttle Cloudflare. Used only when the primary can't be
 * reached and the mirror answers; if it doesn't exist or is down, the app simply stays on the primary.
 */
const MIRRORS = ["https://ru.mail.cumuluscloud.app"];
const ALL = [PRIMARY, ...MIRRORS];

const isOurOrigin = (url) => {
  try { return ALL.includes(new URL(url).origin); } catch { return false; }
};

/** Probe each origin in turn; return the first that answers, else the primary (the app then shows its offline page). */
async function pickOrigin(fetchImpl = fetch, timeoutMs = 6000) {
  for (const origin of ALL) {
    try {
      const res = await fetchImpl(`${origin}/manifest.webmanifest`, { signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
      if (res.ok) return origin;
    } catch {}
  }
  return PRIMARY;
}

/**
 * What a link handed to the app (by the OS) asks for:
 *   cumulus-mail://signin?code=...   finish signing in through the browser
 *   mailto:someone@example.com?subject=Hi   start a new message
 */
function parseAppLink(link) {
  let url;
  try { url = new URL(link); } catch { return null; }
  if (url.protocol === "cumulus-mail:") {
    const action = (url.hostname || url.pathname.replace(/^\/+/, "")).replace(/\/+$/, "");
    const code = url.searchParams.get("code");
    if (action === "signin" && code && /^[A-Za-z0-9_-]{20,64}$/.test(code)) return { type: "signin", code };
    return null;
  }
  if (url.protocol === "mailto:") {
    const to = decodeURIComponent(url.pathname || "").split(",").map((s) => s.trim()).filter(Boolean).join(", ");
    return { type: "compose", to: to.slice(0, 2000), subject: (url.searchParams.get("subject") || "").slice(0, 500), body: (url.searchParams.get("body") || "").slice(0, 20000) };
  }
  return null;
}

/** The first app link in a process's command line (Windows and Linux pass them as arguments). */
const linkFromArgv = (argv) => argv.find((a) => /^(cumulus-mail|mailto):/i.test(a)) || null;

/** Unread count from the page title, e.g. "Inbox (3) · Cumulus://Mail". */
const unreadFromTitle = (title) => {
  const m = /\((\d+)\)/.exec(title || "");
  return m ? Number(m[1]) : 0;
};

module.exports = { PRIMARY, MIRRORS, ALL, isOurOrigin, pickOrigin, parseAppLink, linkFromArgv, unreadFromTitle };
