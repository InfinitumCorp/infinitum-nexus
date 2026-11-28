/**
 * Explains a page that failed to load because it is blocked in Russia.
 * It only adds an issue to the popup. It never changes routing, DNS or the
 * tunnel, so VEIL stays all-or-nothing.
 */
import { RU_BLOCKED } from "./region-blocks.js";

/** Network errors that blocking produces: resets, timeouts, failed TLS, DNS lies. */
const BLOCK_LIKE = /ERR_(CONNECTION_(RESET|CLOSED|TIMED_OUT|REFUSED|FAILED)|TIMED_OUT|SSL_PROTOCOL_ERROR|NAME_NOT_RESOLVED|EMPTY_RESPONSE|NETWORK_ACCESS_DENIED|QUIC_PROTOCOL_ERROR|TUNNEL_CONNECTION_FAILED)|NS_ERROR_(NET_RESET|NET_TIMEOUT|CONNECTION_REFUSED|UNKNOWN_HOST|NET_INTERRUPT)/i;

/** True when the host or one of its parent domains is on the list. */
export function isRegionBlocked(host, list = RU_BLOCKED) {
  let h = String(host ?? "").toLowerCase().replace(/\.$/, "");
  while (h.includes(".")) {
    if (list.has(h)) return true;
    h = h.slice(h.indexOf(".") + 1);
  }
  return false;
}

/**
 * A main-frame error on a host blocked in Russia, while this browser is not
 * routed through VEIL or Tor. Returns an issue or null.
 */
export function assessRegionBlock(url, error, routeMode, list = RU_BLOCKED) {
  if (routeMode === "veil" || routeMode === "tor") return null;
  if (!BLOCK_LIKE.test(String(error ?? ""))) return null;
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  if (!isRegionBlocked(host, list)) return null;
  return {
    kind: "region-blocked",
    title: "Blocked in Russia",
    detail: `${host} is on the Russian block list, and it did not load (${error}). Connect VEIL VPN or turn on Tor to reach it.`,
    fixes: [{ action: "tor", label: "Open over Tor" }],
  };
}
