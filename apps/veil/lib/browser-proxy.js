/**
 * Applies the local Tor SOCKS policy.
 * Firefox attaches per-request SOCKS credentials (circuit isolation).
 * Chrome supplies those same credentials when the proxy asks.
 * While Tor is on, non-loopback traffic never falls back to DIRECT.
 */
import {
  WEBRTC_POLICY,
  chromeTorSettings,
  directFirefox,
  failClosedFirefox,
  firefoxTorProxy,
  isLoopback,
  normalizeTorEndpoint,
  socksIsolation,
} from "./proxy.js";

function freshIdentity(random) {
  const value = random();
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(value)) {
    throw new Error("Could not mint a Tor isolation identity");
  }
  return value;
}

export function createTorProxy(platform, random = () => `id_${Math.random().toString(36).slice(2, 12)}`) {
  let mode = "booting";
  let status = "off";
  let endpoint = normalizeTorEndpoint();
  let identity = freshIdentity(random);
  let generation = 1;

  function isolate(url, tabId) {
    return socksIsolation(url, identity, tabId);
  }

  function firefoxRoute(url, tabId) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      return mode === "off" ? directFirefox() : failClosedFirefox();
    }
    if (isLoopback(host)) return directFirefox();
    if (mode === "off") return directFirefox();
    if (mode === "booting") return failClosedFirefox();
    return firefoxTorProxy(endpoint, isolate(url, tabId));
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
        mode: mode === "booting" ? "booting" : mode,
        status: mode === "booting" ? "booting" : status,
        endpoint: { host: endpoint.host, port: endpoint.port },
        generation,
        dns: mode === "off" ? "local" : "tor",
        browserOnly: true,
        deviceWide: false,
        fingerprinting: "not-tor-browser",
        webrtc: WEBRTC_POLICY,
      };
    },
    onRequest(details) {
      const url = typeof details === "string" ? details : details?.url;
      const tabId = typeof details === "object" ? details?.tabId : undefined;
      return firefoxRoute(url, tabId);
    },
    onAuthRequired(details) {
      if (!details?.isProxy) return { response: {}, failClosed: false };
      const host = String(details.challenger?.host ?? "").toLowerCase();
      const port = Number(details.challenger?.port);
      const ours = isLoopback(host) && port === endpoint.port;
      if (mode !== "on" || !ours) return { response: { cancel: true }, failClosed: false };
      const creds = isolate(details.url, details.tabId);
      return { response: { authCredentials: creds }, failClosed: false };
    },
    onProxyError() {
      return mode === "on";
    },
    markUnreachable() {
      if (mode !== "on") return;
      status = "unreachable";
    },
    setStatus(next) {
      if (mode === "on") status = next;
    },
    readyOff() {
      if (mode === "booting") {
        mode = "off";
        status = "off";
      }
    },
    async enable(next) {
      const chosen = normalizeTorEndpoint(next);
      const previous = { mode, status, endpoint };
      endpoint = chosen;
      mode = "on";
      status = "checking";
      try {
        await platform.setWebRtc(WEBRTC_POLICY);
        if (platform.kind === "chrome") await platform.setProxy(chromeTorSettings(chosen));
        await platform.disablePrediction?.();
      } catch (err) {
        mode = previous.mode;
        status = previous.status;
        endpoint = previous.endpoint;
        if (previous.mode === "off" || previous.mode === "booting") await platform.clearWebRtc().catch(() => {});
        throw err;
      }
    },
    async reapply() {
      if (mode !== "on") return;
      if (platform.kind === "chrome") await platform.setProxy(chromeTorSettings(endpoint));
      await platform.flushAuth?.();
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
      if (platform.kind === "chrome") await platform.clearProxy();
      await platform.clearWebRtc();
      await platform.enablePrediction?.();
    },
  };
}

export function detectPlatform(root = globalThis) {
  const predictionOf = (privacy) => privacy?.network?.networkPredictionEnabled;
  const webrtcOf = (privacy) => privacy?.network?.webRTCIPHandlingPolicy;
  if (root.browser?.proxy?.onRequest?.addListener) {
    const privacy = root.browser.privacy;
    const policy = webrtcOf(privacy);
    const prediction = predictionOf(privacy);
    return {
      kind: "firefox",
      async setProxy() {},
      async clearProxy() {},
      async flushAuth() {
        await root.browser.webRequest?.handlerBehaviorChanged?.();
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
    };
  }
  const settings = root.chrome?.proxy?.settings;
  const privacy = root.chrome?.privacy;
  const policy = webrtcOf(privacy);
  const prediction = predictionOf(privacy);
  return {
    kind: "chrome",
    async setProxy(value) {
      if (!settings?.set) throw new Error("This browser has no proxy settings API");
      await settings.set({ value, scope: "regular" });
    },
    async clearProxy() {
      await settings?.clear?.({ scope: "regular" });
    },
    async flushAuth() {
      await root.chrome?.webRequest?.handlerBehaviorChanged?.();
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
  };
}
