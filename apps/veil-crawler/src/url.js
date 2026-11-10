/**
 * Which URLs VEILBot will crawl. Public web pages only: http(s) on default ports, real host
 * names (no IP addresses, localhost or internal names), no logins, carts, accounts or
 * session links, no file downloads. Tracking parameters are removed, so one page is one URL.
 */
import { TRACKERS as TRACKING_PARAMS } from "../../veil/lib/privacy.js";

export const MAX_URL_LENGTH = 512;

const SKIP_EXT = /\.(?:pdf|zip|gz|tgz|rar|7z|tar|exe|msi|dmg|apk|iso|bin|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp3|mp4|m4a|wav|ogg|webm|mov|avi|mkv|woff2?|ttf|otf|eot|css|js|json|xml|rss|atom|csv|xlsx?|docx?|pptx?)$/i;
const SKIP_PATH = /(?:^|\/)(?:login|log-in|logout|signin|sign-in|signup|sign-up|register|account|accounts|my-account|cart|basket|checkout|password|reset|wp-admin|wp-login\.php|admin|user\/edit|session|oauth|auth)(?:\/|$|\.)/i;
const SESSION_PARAMS = /^(?:sid|sessionid|session_id|phpsessid|jsessionid|token|auth|key|apikey|api_key|access_token|code|state|password|email)$/i;
const INTERNAL_HOST = /(?:^localhost$|\.localhost$|\.local$|\.internal$|\.lan$|\.home$|\.corp$|\.test$|\.example$|\.invalid$|\.onion$)/i;
const TRACKERS = new Set(TRACKING_PARAMS.map((p) => p.toLowerCase()));

/** The canonical form of a crawlable URL, or null if VEILBot must not crawl it. */
export function crawlable(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || INTERNAL_HOST.test(host)) return null;
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return null; // IP literals
  if (SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname)) return null;
  for (const k of [...u.searchParams.keys()]) {
    if (SESSION_PARAMS.test(k)) return null;
    if (TRACKERS.has(k.toLowerCase())) u.searchParams.delete(k);
  }
  u.hostname = host;
  u.hash = "";
  const out = u.toString();
  return out.length <= MAX_URL_LENGTH ? out : null;
}

export function hostOf(url) {
  return new URL(url).hostname;
}

/** Path and query, as robots.txt rules see it. */
export function robotsPath(url) {
  const u = new URL(url);
  return (u.pathname || "/") + u.search;
}
