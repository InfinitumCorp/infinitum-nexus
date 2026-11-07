/**
 * One browser route at a time: VEIL exit proxy (default product) or optional
 * local Tor. Both keep WebRTC non-proxied UDP off and send DNS through the
 * proxy. Neither falls open to a direct connection while it is selected.
 */
import {
  WEBRTC_POLICY,
  chromeFailClosed,
  chromeFixedServers,
  chromeTorSettings,
  directFirefox,
  failClosedFirefox,
  firefoxProxyInfo,
  firefoxTorProxy,
  isLoopback,
  isOnion,
  normalizeServer,
  normalizeTorEndpoint,
  safeBypassHosts,
  socksIsolation,
} from "./proxy.js";

function freshIdentity(random) {
  const value = random();
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
    throw new Error("Could not mint a Tor isolation identity");
  }
  return value;
}

export function createRouteProxy(platform, random = () => `id_${Math.random().toString(36).slice(2, 12)}`, now = () => Date.now()) {
  let mode = "booting";
  let status = "off";
  let endpoint = normalizeTorEndpoint();
  let server = null;
  let secret = null;
  let bypassHosts = [];
  let identity = freshIdentity(random);
  let generation = 1;

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  function directHost(host) {
    if (isLoopback(host)) return true;
    if (isOnion(host)) return false;
    if (mode !== "veil") return false;
    return safeBypassHosts(bypassHosts).some((item) => item.toLowerCase().replace(/^\[|\]$/g, "") === host.toLowerCase().replace(/^\[|\]$/g, ""));
  }

  function firefoxRoute(url, tabId) {
    const host = hostOf(url);
    if (!host) return mode === "off" ? directFirefox() : failClosedFirefox();
    if (directHost(host)) return directFirefox();
    if (mode === "off") return directFirefox();
    if (status === "unreachable" || mode === "booting") return failClosedFirefox();
    if (mode === "tor") return firefoxTorProxy(endpoint, socksIsolation(url, identity, tabId));
    if (mode === "veil" && server) return firefoxProxyInfo(server);
    return failClosedFirefox();
  }

  async function protect(apply) {
    await platform.setWebRtc(WEBRTC_POLICY);
    if (platform.kind === "chrome") await platform.setProxy(apply);
    await platform.disablePrediction?.();
  }

  return {
    get mode() {
      return mode;
    },
    get status() {
      return status;
    },
    get generation() {
      return generation;
    },
    get publicState() {
      return {
        mode,
        status: mode === "booting" ? "booting" : status,
        endpoint: { host: endpoint.host, port: endpoint.port },
        server: server ? { ...server } : null,
        generation,
        dns: mode === "tor" ? "tor" : mode === "veil" ? "through-proxy" : "local",
        browserOnly: true,
        deviceWide: false,
        fingerprinting: "not-tor-browser",
        webrtc: mode === "off" || mode === "booting" ? "default" : WEBRTC_POLICY,
        defaultMode: "veil",
      };
    },
    onRequest(details) {
      const url = typeof details === "string" ? details : details?.url;
      const tabId = typeof details === "object" ? details?.tabId : undefined;
      return firefoxRoute(url, tabId);
    },
    onAuthRequired(details) {
      if (!details?.isProxy) return { response: {} };
      if (mode !== "veil" && mode !== "tor") return { response: {} };
      const host = String(details.challenger?.host ?? "").toLowerCase();
      const port = Number(details.challenger?.port);
      if (mode === "tor" && isLoopback(host) && port === endpoint.port && status !== "unreachable") {
        return { response: { authCredentials: socksIsolation(details.url, identity, details.tabId) } };
      }
      if (mode === "veil" && server && host === server.host && port === server.port && secret) {
        return { response: { authCredentials: { username: secret.username, password: secret.password } } };
      }
      return { response: { cancel: true } };
    },
    onProxyError() {
      return mode === "veil" || mode === "tor";
    },
    markUnreachable() {
      if (mode !== "veil" && mode !== "tor") return;
      status = "unreachable";
      secret = null;
    },
    setStatus(next) {
      if (mode === "tor" || mode === "veil") status = next;
    },
    readyOff() {
      if (mode === "booting") {
        mode = "off";
        status = "off";
      }
    },
    async enable(next) {
      const chosen = normalizeTorEndpoint(next);
      const previous = { mode, status, endpoint, server, secret, bypassHosts: [...bypassHosts] };
      endpoint = chosen;
      server = null;
      secret = null;
      bypassHosts = [];
      mode = "tor";
      status = "checking";
      try {
        await protect(chromeTorSettings(chosen));
      } catch (err) {
        mode = previous.mode;
        status = previous.status;
        endpoint = previous.endpoint;
        server = previous.server;
        secret = previous.secret;
        bypassHosts = previous.bypassHosts;
        throw err;
      }
    },
    async enableVeil(nextServer, auth, hosts) {
      const chosen = normalizeServer(nextServer);
      if (!auth || typeof auth.username !== "string" || typeof auth.password !== "string") {
        throw new Error("Proxy credentials are missing");
      }
      const expiresAt = Date.parse(auth.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new Error("Proxy credentials are already expired");
      const previous = { mode, status, server, secret, bypassHosts: [...bypassHosts] };
      server = chosen;
      secret = { username: auth.username, password: auth.password, expiresAt: auth.expiresAt };
      bypassHosts = [...(hosts ?? [])];
      mode = "veil";
      status = "veil";
      try {
        await protect(chromeFixedServers(chosen, bypassHosts));
      } catch (err) {
        mode = previous.mode;
        status = previous.status;
        server = previous.server;
        secret = previous.secret;
        bypassHosts = previous.bypassHosts;
        throw err;
      }
    },
    async failClosed() {
      if (mode !== "veil" && mode !== "tor") {
        mode = "veil";
      }
      status = "unreachable";
      secret = null;
      await protect(chromeFailClosed()).catch(() => {});
    },
    async reapply() {
      if (mode === "tor") {
        if (platform.kind === "chrome") await platform.setProxy(chromeTorSettings(endpoint));
        await platform.flushAuth?.();
      }
    },
    rotate() {
      identity = freshIdentity(random);
      generation += 1;
      return generation;
    },
    async disable() {
      if (mode === "off" || mode === "booting") {
        mode = "off";
        status = "off";
        return;
      }
      mode = "off";
      status = "off";
      server = null;
      secret = null;
      if (platform.kind === "chrome") await platform.clearProxy();
      await platform.clearWebRtc();
      await platform.enablePrediction?.();
    },
  };
}

export const createTorProxy = createRouteProxy;

export function detectPlatform(root = globalThis) {
  const predictionOf = (privacy) => privacy?.network?.networkPredictionEnabled;
  const webrtcOf = (privacy) => privacy?.network?.webRTCIPHandlingPolicy;
  const base = (kind, privacy, rootNs) => {
    const policy = webrtcOf(privacy);
    const prediction = predictionOf(privacy);
    return {
      async flushAuth() {
        await rootNs?.webRequest?.handlerBehaviorChanged?.();
      },
      async setWebRtc(value) {
        if (!policy?.set) throw new Error("This browser cannot limit WebRTC leaks");
        await policy.set({ value });
      },
      async clearWebRtc() {
        await policy?.clear?.({});
      },
      async disablePrediction() {
        await prediction?.set?.({ value: false });
      },
      async enablePrediction() {
        await prediction?.clear?.({});
      },
      kind,
    };
  };
  if (root.browser?.proxy?.onRequest?.addListener) {
    return {
      ...base("firefox", root.browser.privacy, root.browser),
      async setProxy() {},
      async clearProxy() {},
    };
  }
  const settings = root.chrome?.proxy?.settings;
  return {
    ...base("chrome", root.chrome?.privacy, root.chrome),
    async setProxy(value) {
      if (!settings?.set) throw new Error("This browser has no proxy settings API");
      await settings.set({ value, scope: "regular" });
    },
    async clearProxy() {
      await settings?.clear?.({ scope: "regular" });
    },
  };
}
