/**
 * Browser proxy policy for VEIL.
 * Chrome's socks5 and https fixed_servers modes hand the destination name to
 * the proxy, so DNS for those requests is resolved there. SOCKS4 is refused
 * because it does not. Fail-closed uses a dead SOCKS5 proxy so a dropped
 * tunnel does not fall open to the network.
 *
 * Keep host checks aligned with server/model.ts.
 */

export const WEBRTC_POLICY = "disable_non_proxied_udp";
export const LOOPBACK = Object.freeze(["localhost", "127.0.0.1", "::1", "[::1]"]);

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DNS = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

function ipv4(host) {
  if (!IPV4.test(host)) return null;
  return host.split(".").map((part) => Number(part));
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
  return {
    id: input.id,
    name,
    region,
    host: input.host.toLowerCase(),
    port: input.port,
    scheme: input.scheme,
  };
}

export function safeBypassHosts(hosts) {
  const out = [];
  for (const host of hosts ?? []) {
    if (LOOPBACK.includes(host) || isProxyHost(host)) out.push(host === "[::1]" || host === "::1" ? host : host.toLowerCase());
  }
  return [...new Set(out)];
}

/** Chrome fixed server. socks5 and https both carry the hostname to the proxy. */
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

/** Firefox browser.proxy.onRequest result. proxyDNS keeps SOCKS name resolution on the proxy. */
export function firefoxProxyInfo(server) {
  const chosen = normalizeServer(server);
  if (chosen.scheme === "socks5") {
    return { type: "socks", host: chosen.host, port: chosen.port, proxyDNS: true };
  }
  return { type: "https", host: chosen.host, port: chosen.port };
}

export function failClosedFirefox() {
  return { type: "socks", host: "127.0.0.1", port: 1, proxyDNS: true };
}

export function directFirefox() {
  return { type: "direct" };
}

export function failClosedPac(bypassHosts) {
  const allow = safeBypassHosts(bypassHosts).map((host) => JSON.stringify(host)).join(",");
  return `function FindProxyForURL(url, host) {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return "DIRECT";
  var allow = [${allow}];
  for (var i = 0; i < allow.length; i++) if (host === allow[i]) return "DIRECT";
  return "SOCKS5 127.0.0.1:1";
}`;
}

export function chromeFailClosed(bypassHosts) {
  return { mode: "pac_script", pacScript: { data: failClosedPac(bypassHosts) } };
}

export function isDirectHost(host, bypassHosts) {
  if (typeof host !== "string") return false;
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (name === "localhost" || name === "127.0.0.1" || name === "::1") return true;
  return safeBypassHosts(bypassHosts).some((item) => item.toLowerCase().replace(/^\[|\]$/g, "") === name);
}

export function bypassHostsFor(origins) {
  const hosts = [...LOOPBACK];
  for (const key of ["cid", "veil"]) {
    try {
      const host = new URL(origins?.[key]).hostname;
      if (host) hosts.push(host);
    } catch {
      /* ignore unusable origins */
    }
  }
  return safeBypassHosts(hosts);
}

export function selectServer(servers, id) {
  const list = Array.isArray(servers) ? servers.map((server) => normalizeServer(server)) : [];
  if (!list.length) throw new Error("No VEIL servers are available");
  const chosen = list.find((server) => server.id === id) ?? null;
  if (!chosen) throw new Error("Select a VEIL server");
  return { servers: list, chosen };
}
