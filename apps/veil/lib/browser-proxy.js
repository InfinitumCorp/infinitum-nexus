/**
 * Applies VEIL's proxy policy through chrome.proxy.settings or Firefox's
 * browser.proxy.onRequest. Proxy passwords stay in memory on this object.
 */
import {
  WEBRTC_POLICY,
  chromeFailClosed,
  chromeFixedServers,
  directFirefox,
  failClosedFirefox,
  firefoxProxyInfo,
  isDirectHost,
  normalizeServer,
} from "./proxy.js";

export function createBrowserProxy(platform, now = () => Date.now()) {
  let mode = "booting";
  let server = null;
  let secret = null;
  let bypassHosts = [];
  const attempts = new Map();

  async function applyWebRtc() {
    if (mode === "off") await platform.clearWebRtc();
    else await platform.setWebRtc(WEBRTC_POLICY);
  }

  return {
    get mode() {
      return mode;
    },
    get publicState() {
      return {
        mode,
        server: server ? { ...server } : null,
        expiresAt: secret?.expiresAt ?? null,
        browserOnly: true,
        deviceWide: false,
        dns: mode === "off" ? "local" : "through-proxy",
      };
    },
    onRequest(url) {
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        return mode === "off" ? directFirefox() : failClosedFirefox();
      }
      if (isDirectHost(host, bypassHosts)) return directFirefox();
      if (mode === "connected" && server) return firefoxProxyInfo(server);
      if (mode === "off") return directFirefox();
      return failClosedFirefox();
    },
    onAuthRequired(details) {
      if (!details?.isProxy) return { response: {}, failClosed: false };
      const id = String(details.requestId ?? "");
      const seen = (attempts.get(id) ?? 0) + 1;
      if (attempts.size > 200) attempts.clear();
      attempts.set(id, seen);
      const host = String(details.challenger?.host ?? "").toLowerCase();
      const port = Number(details.challenger?.port);
      const matches = !!server && host === server.host && port === server.port && !!secret;
      if (!matches || seen > 1 || mode !== "connected") {
        return { response: { cancel: true }, failClosed: mode === "connected" };
      }
      return {
        response: { authCredentials: { username: secret.username, password: secret.password } },
        failClosed: false,
      };
    },
    onProxyError() {
      return mode === "connected";
    },
    async connect(nextServer, auth, hosts) {
      const chosen = normalizeServer(nextServer);
      if (!auth || typeof auth.username !== "string" || typeof auth.password !== "string") {
        throw new Error("Proxy credentials are missing");
      }
      const expiresAt = Date.parse(auth.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= now()) throw new Error("Proxy credentials are already expired");
      const previous = { mode, server, secret, bypassHosts: [...bypassHosts] };
      server = chosen;
      secret = { username: auth.username, password: auth.password, expiresAt: auth.expiresAt };
      bypassHosts = [...(hosts ?? [])];
      mode = "connected";
      try {
        await applyWebRtc();
        if (platform.kind === "chrome") await platform.setProxy(chromeFixedServers(chosen, bypassHosts));
      } catch (err) {
        mode = previous.mode;
        server = previous.server;
        secret = previous.secret;
        bypassHosts = previous.bypassHosts;
        if (previous.mode === "off") await platform.clearWebRtc().catch(() => {});
        throw err;
      }
    },
    async failClosed(hosts) {
      if (hosts) bypassHosts = [...hosts];
      secret = null;
      mode = "fail-closed";
      if (platform.kind === "chrome") await platform.setProxy(chromeFailClosed(bypassHosts));
      await platform.setWebRtc(WEBRTC_POLICY);
    },
    readyOff() {
      if (mode === "booting") mode = "off";
    },
    async disconnect() {
      if (mode === "off" || mode === "booting") {
        mode = "off";
        return;
      }
      mode = "off";
      secret = null;
      server = null;
      attempts.clear();
      if (platform.kind === "chrome") await platform.clearProxy();
      await platform.clearWebRtc();
    },
  };
}

export function detectPlatform(root = globalThis) {
  if (root.browser?.proxy?.onRequest?.addListener) {
    const privacy = root.browser.privacy?.network?.webRTCIPHandlingPolicy;
    return {
      kind: "firefox",
      async setProxy() {},
      async clearProxy() {},
      async setWebRtc(value) {
        if (!privacy?.set) throw new Error("This browser cannot limit WebRTC leaks");
        await privacy.set({ value });
      },
      async clearWebRtc() {
        await privacy?.clear?.({});
      },
    };
  }
  const settings = root.chrome?.proxy?.settings;
  const privacy = root.chrome?.privacy?.network?.webRTCIPHandlingPolicy;
  return {
    kind: "chrome",
    async setProxy(value) {
      if (!settings?.set) throw new Error("This browser has no proxy settings API");
      await settings.set({ value, scope: "regular" });
    },
    async clearProxy() {
      await settings?.clear?.({ scope: "regular" });
    },
    async setWebRtc(value) {
      if (!privacy?.set) throw new Error("This browser cannot limit WebRTC leaks");
      await privacy.set({ value });
    },
    async clearWebRtc() {
      await privacy?.clear?.({});
    },
  };
}
