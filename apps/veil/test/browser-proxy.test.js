import { test } from "node:test";
import assert from "node:assert/strict";
import { createTorProxy, detectPlatform } from "../lib/browser-proxy.js";

function platform(kind = "chrome") {
  const calls = { set: [], clear: 0, webrtc: [], prediction: [], flush: 0 };
  return {
    calls,
    kind,
    async setProxy(value) { calls.set.push(value); },
    async clearProxy() { calls.clear += 1; },
    async setWebRtc(value) { calls.webrtc.push(value); },
    async clearWebRtc() { calls.webrtc.push("cleared"); },
    async disablePrediction() { calls.prediction.push(false); },
    async enablePrediction() { calls.prediction.push("cleared"); },
    async flushAuth() { calls.flush += 1; },
  };
}

test("Firefox stays fail-closed until Tor is explicitly off", () => {
  const proxy = createTorProxy(platform("firefox"), () => "identity_one");
  assert.equal(proxy.onRequest("https://news.example/a").port, 1);
  assert.equal(proxy.onRequest("http://example.onion/").proxyDNS, true);
  assert.deepEqual(proxy.onRequest("http://127.0.0.1:9050/"), { type: "direct" });
  proxy.readyOff();
  assert.deepEqual(proxy.onRequest("https://news.example/a"), { type: "direct" });
});

test("an enabled Tor client gets per-site SOCKS auth and remote DNS, including .onion", async () => {
  const firefox = platform("firefox");
  let n = 0;
  const proxy = createTorProxy(firefox, () => `identity_${++n}_key`);
  await proxy.enable({ port: 9150 });
  const news = proxy.onRequest({ url: "https://news.example/a", tabId: 2 });
  const onion = proxy.onRequest({ url: "http://example.onion/x", tabId: 2 });
  assert.equal(news.proxyDNS, true);
  assert.equal(news.port, 9150);
  assert.equal(news.failoverTimeout, undefined);
  assert.notEqual(news.username, onion.username);
  assert.match(onion.username, /example\.onion/);
  assert.equal(firefox.calls.set.length, 0);
  assert.equal(firefox.calls.webrtc.at(-1), "disable_non_proxied_udp");
  const other = proxy.onRequest({ url: "https://news.example/a", tabId: 9 });
  assert.notEqual(news.password, other.password);
  const generation = proxy.rotate();
  const rotated = proxy.onRequest({ url: "https://news.example/a", tabId: 2 });
  assert.notEqual(news.password, rotated.password);
  assert.equal(generation, 2);
  assert.equal(JSON.stringify(proxy.publicState).includes(rotated.password), false);
});

test("Chrome points at local SOCKS5 and a proxy error does not fall open", async () => {
  const chrome = platform("chrome");
  const proxy = createTorProxy(chrome, () => "identity_one");
  await proxy.enable({ port: 9050 });
  assert.deepEqual(chrome.calls.set[0].rules.singleProxy, { scheme: "socks5", host: "127.0.0.1", port: 9050 });
  assert.equal(chrome.calls.set[0].rules.bypassList.includes("example.onion"), false);
  const auth = proxy.onAuthRequired({
    isProxy: true, url: "https://news.example/", tabId: 1, challenger: { host: "127.0.0.1", port: 9050 },
  });
  assert.match(auth.response.authCredentials.username, /news\.example/);
  const again = proxy.onAuthRequired({
    isProxy: true, url: "https://other.example/", tabId: 1, challenger: { host: "127.0.0.1", port: 9050 },
  });
  assert.notEqual(again.response.authCredentials.username, auth.response.authCredentials.username);
  assert.equal(again.response.cancel, undefined);
  assert.equal(proxy.onProxyError(), true);
  proxy.markUnreachable();
  assert.equal(proxy.status, "unreachable");
  assert.equal(proxy.mode, "tor");
  assert.equal(chrome.calls.clear, 0);
  await proxy.disable();
  assert.equal(chrome.calls.clear, 1);
  assert.equal(chrome.calls.webrtc.at(-1), "cleared");
});

test("platform detection prefers Firefox onRequest", () => {
  const firefox = detectPlatform({
    browser: { proxy: { onRequest: { addListener() {} } }, privacy: { network: { webRTCIPHandlingPolicy: { set: async () => {}, clear: async () => {} } } } },
    chrome: { proxy: { settings: { set: async () => {} } } },
  });
  assert.equal(firefox.kind, "firefox");
});
