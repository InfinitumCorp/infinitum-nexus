/**
 * VEIL connection-safety checks. Pure functions; the background wires them
 * to navigation events and the popup shows each issue with a one-tap fix.
 *
 * Fixes: "https" (load the https:// URL), "back" (leave the page),
 * "tor" (re-check the page over VEIL's Tor route).
 */

export function isOnion(host) {
  return /(^|\.)onion\.?$/i.test(String(host ?? ""));
}

export function isLocal(host) {
  const h = String(host ?? "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * A punycode label (xn--) can render as letters that imitate another
 * site's name. VEIL flags it so the user sees the real name.
 */
export function isLookalike(host) {
  return String(host ?? "").toLowerCase().split(".").some((label) => label.startsWith("xn--"));
}

/** Issues visible from the page URL alone. */
export function assessUrl(url) {
  const u = parse(url);
  if (!u || (u.protocol !== "http:" && u.protocol !== "https:")) return [];
  const issues = [];
  if (u.protocol === "http:" && !isOnion(u.hostname) && !isLocal(u.hostname)) {
    const https = new URL(u.href);
    https.protocol = "https:";
    issues.push({
      kind: "http-only",
      title: "Not encrypted",
      detail: `${u.hostname} loaded over HTTP. Anyone on the network can read or change it.`,
      fixes: [{ action: "https", label: "Switch to HTTPS", url: https.href }, { action: "back", label: "Go back" }],
    });
  }
  if (isLookalike(u.hostname)) {
    issues.push({
      kind: "lookalike",
      title: "Look-alike address",
      detail: `This address is ${u.hostname}. Its letters can imitate another site's name.`,
      fixes: [{ action: "back", label: "Go back" }],
    });
  }
  return issues;
}

/** A redirect from https to http on a main frame. */
export function assessRedirect(fromUrl, toUrl) {
  const from = parse(fromUrl);
  const to = parse(toUrl);
  if (!from || !to || from.protocol !== "https:" || to.protocol !== "http:") return null;
  if (isOnion(to.hostname) || isLocal(to.hostname)) return null;
  const https = new URL(to.href);
  https.protocol = "https:";
  return {
    kind: "downgrade",
    title: "Encryption was removed",
    detail: `${from.hostname} sent this tab from HTTPS to plain HTTP.`,
    fixes: [{ action: "https", label: "Reload over HTTPS", url: https.href }, { action: "back", label: "Go back" }],
  };
}

/** A main-frame network error. Certificate errors become an issue. */
export function assessError(url, error) {
  if (!/ERR_CERT_|SEC_ERROR_|SSL_ERROR_|MOZILLA_PKIX_ERROR_/i.test(String(error ?? ""))) return null;
  const u = parse(url);
  return {
    kind: "cert-invalid",
    title: "Certificate problem",
    detail: `${u?.hostname ?? "This site"} presented a certificate the browser does not trust (${error}). Someone may be intercepting the connection.`,
    fixes: [{ action: "back", label: "Go back" }, { action: "tor", label: "Check over Tor" }],
  };
}

/** Keep one issue per kind; the newest wins. */
export function mergeIssues(existing, added) {
  const out = new Map();
  for (const issue of [...(existing ?? []), ...(added ?? [])]) if (issue) out.set(issue.kind, issue);
  return [...out.values()];
}
