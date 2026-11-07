/**
 * Tor routing policy for VEIL.
 * Traffic goes to a local Tor SOCKS5 client. SOCKS5 (never SOCKS4) and
 * Firefox proxyDNS send the destination name, including .onion, to Tor.
 * Loopback is the only direct exception, so the browser can reach that client.
 * There is no operator exit in this path.
 */

export const WEBRTC_POLICY = "disable_non_proxied_udp";
export const DEFAULT_TOR_PORT = 9050;
export const TOR_BROWSER_PORT = 9150;
export const CHECK_URL = "https://check.torproject.org/api/ip";

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

function ipv4(host) {
  if (!IPV4.test(host)) return null;
  return host.split(".").map((part) => Number(part));
}

export function isLoopback(host) {
  if (typeof host !== "string" || !host) return false;
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name === "::1") return true;
  const parts = ipv4(name);
  return !!parts && parts[0] === 127;
}

export function isOnion(host) {
  return typeof host === "string" && host.toLowerCase().replace(/\.$/, "").endsWith(".onion");
}

/** Only a local Tor client. Remote SOCKS endpoints are rejected. */
export function normalizeTorEndpoint(input = {}) {
  const host = typeof input.host === "string" && input.host ? input.host : "127.0.0.1";
  if (!isLoopback(host)) throw new Error("VEIL only routes through a local Tor client");
  const port = input.port === undefined ? DEFAULT_TOR_PORT : input.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Tor port is invalid");
  return { host: "127.0.0.1", port, scheme: "socks5" };
}

export function endpointLabel(endpoint) {
  const chosen = normalizeTorEndpoint(endpoint);
  if (chosen.port === DEFAULT_TOR_PORT) return `System Tor · ${chosen.host}:${chosen.port}`;
  if (chosen.port === TOR_BROWSER_PORT) return `Tor Browser · ${chosen.host}:${chosen.port}`;
  return `Local Tor · ${chosen.host}:${chosen.port}`;
}

/**
 * SOCKS username/password pair used as Tor's IsolateSOCKSAuth key.
 * Username is the site. Password mixes the identity epoch and the tab,
 * so a new identity and a different tab do not share a circuit.
 * The local Tor client must be started with IsolateSOCKSAuth (Tor Browser's
 * 9150 port already does this).
 */
export function socksIsolation(url, identity, tabId) {
  if (typeof identity !== "string" || !/^[A-Za-z0-9_-]{8,200}$/.test(identity)) {
    throw new Error("Tor isolation identity is invalid");
  }
  let host = "unknown";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = "unknown";
  }
  const site = host.replace(/[^a-z0-9.-]/g, "_").replace(/^\.+|\.+$/g, "").slice(0, 180) || "unknown";
  const stream = Number.isInteger(tabId) && tabId >= 0 ? `.${tabId}` : "";
  const username = `s_${site}`.slice(0, 255);
  const password = `${identity}${stream}`.slice(0, 255);
  if (username.includes("\0") || password.includes("\0") || /[\r\n]/.test(username + password)) {
    throw new Error("Tor isolation credentials were refused");
  }
  return { username, password };
}

export function chromeTorSettings(endpoint) {
  const chosen = normalizeTorEndpoint(endpoint);
  return {
    mode: "fixed_servers",
    rules: {
      singleProxy: { scheme: "socks5", host: chosen.host, port: chosen.port },
      bypassList: ["localhost", "127.0.0.1", "[::1]"],
    },
  };
}

/** No failoverTimeout: Firefox must not fall through to a direct connection. */
export function firefoxTorProxy(endpoint, isolation) {
  const chosen = normalizeTorEndpoint(endpoint);
  return {
    type: "socks",
    host: chosen.host,
    port: chosen.port,
    proxyDNS: true,
    username: isolation.username,
    password: isolation.password,
  };
}

export function failClosedFirefox() {
  return { type: "socks", host: "127.0.0.1", port: 1, proxyDNS: true };
}

export function directFirefox() {
  return { type: "direct" };
}

export function parseTorCheck(body) {
  if (!body || typeof body !== "object" || typeof body.IsTor !== "boolean") {
    return { isTor: false, ip: null, error: "Tor check was unreadable" };
  }
  const ip = typeof body.IP === "string" && /^[0-9a-f:.]+$/i.test(body.IP) ? body.IP : null;
  return { isTor: body.IsTor, ip, error: null };
}
