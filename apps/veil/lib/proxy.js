/**
 * Route policy for VEIL.
 * Default mode is the CID-entitled exit proxy (HTTPS or SOCKS5). DNS for
 * those requests is resolved by the proxy. Optional Tor mode uses a local
 * SOCKS5 client only. SOCKS4 is refused. .onion names are never bypassed.
 */

export const WEBRTC_POLICY = "disable_non_proxied_udp";
export const DEFAULT_TOR_PORT = 9050;
export const TOR_BROWSER_PORT = 9150;
export const CHECK_URL = "https://check.torproject.org/api/ip";
export const LOOPBACK = Object.freeze(["localhost", "127.0.0.1", "::1", "[::1]"]);

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DNS = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
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

export function isUnsafeProxyHost(host) {
  const parts = ipv4(host);
  if (!parts) return host === "metadata.google.internal";
  const [a, b] = parts;
  return a === 0 || a === 255 || (a === 169 && b === 254);
}

export function isProxyHost(host) {
  if (typeof host !== "string") return false;
  const name = host.toLowerCase();
  if (name.includes("%") || name.includes("@") || name.includes("/") || name.includes(":") || name.includes("\\")) return false;
  if (!(DNS.test(name) || IPV4.test(name))) return false;
  return !isUnsafeProxyHost(name);
}

export function normalizeServer(input) {
  if (!input || typeof input !== "object") throw new Error("VEIL server is missing");
  if (typeof input.id !== "string" || !ID.test(input.id)) throw new Error("VEIL server id is invalid");
  if (!isProxyHost(input.host)) throw new Error("VEIL server host is invalid");
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("VEIL server port is invalid");
  if (input.scheme !== "https" && input.scheme !== "socks5") throw new Error("VEIL server scheme must be https or socks5");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const region = typeof input.region === "string" ? input.region.trim() : "";
  if (!name || name.length > 60 || !region || region.length > 40) throw new Error("VEIL server label is invalid");
  return { id: input.id, name, region, host: input.host.toLowerCase(), port: input.port, scheme: input.scheme };
}

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
  if (/[\u0000\r\n]/.test(username + password)) throw new Error("Tor isolation credentials were refused");
  return { username, password };
}

export function safeBypassHosts(hosts) {
  const out = [];
  for (const host of hosts ?? []) {
    if (isOnion(host)) continue;
    if (LOOPBACK.includes(host) || isProxyHost(host) || isLoopback(host)) {
      out.push(host === "[::1]" || host === "::1" ? host : String(host).toLowerCase());
    }
  }
  return [...new Set(out)];
}

export function bypassHostsFor(origins) {
  const hosts = [...LOOPBACK];
  for (const key of ["cid", "veil"]) {
    try {
      const host = new URL(origins?.[key]).hostname;
      if (host && !isOnion(host)) hosts.push(host);
    } catch {
      /* ignore */
    }
  }
  return safeBypassHosts(hosts);
}

export function chromeFixedServers(server, bypassHosts) {
  const chosen = normalizeServer(server);
  return {
    mode: "fixed_servers",
    rules: {
      singleProxy: { scheme: chosen.scheme, host: chosen.host, port: chosen.port },
      bypassList: safeBypassHosts(bypassHosts),
    },
  };
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

export function firefoxProxyInfo(server) {
  const chosen = normalizeServer(server);
  if (chosen.scheme === "socks5") return { type: "socks", host: chosen.host, port: chosen.port, proxyDNS: true };
  return { type: "https", host: chosen.host, port: chosen.port };
}

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

export function chromeFailClosed() {
  return {
    mode: "fixed_servers",
    rules: {
      singleProxy: { scheme: "socks5", host: "127.0.0.1", port: 1 },
      bypassList: ["localhost", "127.0.0.1", "[::1]"],
    },
  };
}

export function parseTorCheck(body) {
  if (!body || typeof body !== "object" || typeof body.IsTor !== "boolean") {
    return { isTor: false, ip: null, error: "Tor check was unreadable" };
  }
  const ip = typeof body.IP === "string" && /^[0-9a-f:.]+$/i.test(body.IP) ? body.IP : null;
  return { isTor: body.IsTor, ip, error: null };
}
