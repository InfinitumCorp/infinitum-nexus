import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserProxy, detectPlatform } from "../lib/browser-proxy.js";

function platform(kind = "chrome") {
  const calls = { set: [], clear: 0, webrtc: [] };
  return {
    calls,
    kind,
    async setProxy(value) { calls.set.push(value); },
    async clearProxy() { calls.clear += 1; },
    async setWebRtc(value) { calls.webrtc.push(value); },
    async clearWebRtc() { calls.webrtc.push("cleared"); },
  };
}

const server = { id: "iad-1", name: "Washington", region: "us-east", host: "veil-iad.example", port: 443, scheme: "https" };
const auth = { username: "v_username_ok", password: "0123456789abcdef", expiresAt: "2026-11-07T12:15:00Z" };
const now = () => Date.parse("2026-11-07T12:00:00Z");

test("connect configures an authenticated https proxy and WebRTC, without publishing the password", async () => {
  const chrome = platform("chrome");
  const proxy = createBrowserProxy(chrome, now);
  await proxy.connect(server, auth, ["localhost", "cid.example"]);
  assert.equal(proxy.mode, "connected");
  assert.equal(chrome.calls.set[0].mode, "fixed_servers");
  assert.equal(chrome.calls.set[0].rules.singleProxy.scheme, "https");
  assert.deepEqual(chrome.calls.set[0].rules.bypassList.sort(), ["cid.example", "localhost"]);
  assert.equal(chrome.calls.webrtc.at(-1), "disable_non_proxied_udp");
  assert.equal(JSON.stringify(proxy.publicState).includes(auth.password), false);
  const details = { isProxy: true, requestId: "1", challenger: { host: "veil-iad.example", port: 443 } };
  assert.deepEqual(proxy.onAuthRequired(details).response.authCredentials.username, auth.username);
  const again = proxy.onAuthRequired(details);
  assert.equal(again.response.cancel, true);
  assert.equal(again.failClosed, true);
  assert.equal(proxy.onAuthRequired({ isProxy: false, requestId: "2" }).failClosed, false);
});

test("a proxy error or mismatched challenger requests fail-closed, and explicit disconnect clears it", async () => {
  const chrome = platform("chrome");
  const proxy = createBrowserProxy(chrome, now);
  await proxy.connect(server, auth, ["localhost"]);
  assert.equal(proxy.onAuthRequired({
    isProxy: true, requestId: "9", challenger: { host: "evil.example", port: 443 },
  }).response.cancel, true);
  assert.equal(proxy.onProxyError(), true);
  await proxy.failClosed(["localhost"]);
  assert.equal(proxy.mode, "fail-closed");
  assert.equal(chrome.calls.set.at(-1).mode, "pac_script");
  assert.match(chrome.calls.set.at(-1).pacScript.data, /SOCKS5 127\.0\.0\.1:1/);
  assert.equal(proxy.onProxyError(), false);
  assert.equal(proxy.publicState.dns, "through-proxy");
  await proxy.disconnect();
  assert.equal(proxy.mode, "off");
  assert.equal(chrome.calls.clear, 1);
  assert.equal(chrome.calls.webrtc.at(-1), "cleared");
  await proxy.disconnect();
  assert.equal(chrome.calls.clear, 1);
});

test("Firefox stays fail-closed until saved state says the proxy is off", async () => {
  const firefox = platform("firefox");
  const proxy = createBrowserProxy(firefox, now);
  assert.equal(proxy.mode, "booting");
  assert.equal(proxy.onRequest("https://news.example/a").port, 1);
  assert.deepEqual(proxy.onRequest("https://localhost/api/veil/session"), { type: "direct" });
  proxy.readyOff();
  assert.deepEqual(proxy.onRequest("https://news.example/a"), { type: "direct" });
  assert.equal(firefox.calls.clear, 0);
});

test("Firefox onRequest sends DNS through SOCKS and blocks when fail-closed", async () => {
  const firefox = platform("firefox");
  const proxy = createBrowserProxy(firefox, now);
  const socks = { ...server, scheme: "socks5", port: 1080 };
  await proxy.connect(socks, auth, ["cid.example"]);
  assert.deepEqual(proxy.onRequest("https://news.example/a"), {
    type: "socks", host: "veil-iad.example", port: 1080, proxyDNS: true,
  });
  assert.deepEqual(proxy.onRequest("https://cid.example/api/veil/session"), { type: "direct" });
  assert.equal(firefox.calls.set.length, 0);
  await proxy.failClosed();
  assert.equal(proxy.onRequest("https://news.example/a").port, 1);
  assert.equal(proxy.onRequest("not a url").proxyDNS, true);
});

test("expired credentials and a failed WebRTC policy do not leave the proxy connected", async () => {
  const chrome = platform("chrome");
  const proxy = createBrowserProxy(chrome, now);
  proxy.readyOff();
  await assert.rejects(() => proxy.connect(server, { ...auth, expiresAt: "2020-01-01T00:00:00Z" }, []), /expired/);
  assert.equal(proxy.mode, "off");
  chrome.setWebRtc = async () => { throw new Error("no webrtc"); };
  await assert.rejects(() => proxy.connect(server, auth, []), /no webrtc/);
  assert.equal(proxy.mode, "off");
  assert.equal(chrome.calls.set.length, 0);
});

test("platform detection prefers Firefox onRequest when both globals exist", () => {
  const firefox = detectPlatform({
    browser: { proxy: { onRequest: { addListener() {} } }, privacy: { network: { webRTCIPHandlingPolicy: { set: async () => {}, clear: async () => {} } } } },
    chrome: { proxy: { settings: { set: async () => {}, clear: async () => {} } } },
  });
  assert.equal(firefox.kind, "firefox");
  const chrome = detectPlatform({ chrome: { proxy: { settings: { set: async () => {}, clear: async () => {} } }, privacy: { network: { webRTCIPHandlingPolicy: { set: async () => {} } } } } });
  assert.equal(chrome.kind, "chrome");
});
