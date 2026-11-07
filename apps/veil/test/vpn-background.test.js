import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fakeChrome } from "./fake-chrome.js";

const env = fakeChrome();
env.chrome.runtime.onStartup = { addListener: (fn) => { env.listeners.startup = fn; } };
env.chrome.proxy.onProxyError = { addListener: (fn) => { env.listeners.proxyError = fn; } };
env.chrome.webRequest = {
  onAuthRequired: { addListener: (fn, filter, extra) => { env.listeners.auth = { fn, filter, extra }; } },
  handlerBehaviorChanged: async () => { env.calls.flush = (env.calls.flush ?? 0) + 1; },
};
globalThis.chrome = env.chrome;
const fromPopup = (msg) => env.send(msg, { id: "veilid", url: "chrome-extension://veilid/popup.html" });
const fromPage = (msg) => env.send(msg, { id: "veilid", url: "https://example.com/", tab: { id: 1, windowId: 1, active: true } });

function mockFetch(routes) {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), opts });
    const hit = routes.find((route) => String(url).includes(route.match));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    if (hit.throw) throw new Error("offline");
    return { ok: hit.status < 400, status: hit.status, json: async () => hit.body };
  };
  return seen;
}

before(async () => {
  await import("../background.js");
  await env.listeners.installed[0]();
});

test("a page cannot turn Tor on or request a new circuit", async () => {
  for (const type of ["toggleTor", "newCircuit", "checkTor", "newIdentity"]) {
    const response = await fromPage({ type, enabled: true });
    assert.match(response.error, /not allowed/, type);
  }
  assert.equal(env.calls.proxySet.length, 0);
});

test("anonymous browsing can use local Tor without calling VEIL servers", async () => {
  const seen = mockFetch([]);
  const response = await fromPopup({ type: "toggleTor", enabled: true });
  assert.equal(response.error, undefined);
  assert.equal(response.enabled, true);
  assert.equal(seen.length, 0);
  const proxy = env.calls.proxySet.at(-1).value;
  assert.deepEqual(proxy.rules.singleProxy, { scheme: "socks5", host: "127.0.0.1", port: 9050 });
  assert.equal(proxy.rules.bypassList.includes("example.onion"), false);
  assert.equal(env.calls.webrtc.at(-1), "disable_non_proxied_udp");
  const state = await fromPopup({ type: "getState" });
  assert.equal(state.tor.dns, "tor");
  assert.equal(state.tor.deviceWide, false);
  assert.equal(state.tor.fingerprinting, "not-tor-browser");
});

test("Tor Browser's port is selectable and .onion gets its own SOCKS identity", async () => {
  await fromPopup({ type: "toggleTor", enabled: true, port: 9150 });
  assert.equal(env.calls.proxySet.at(-1).value.rules.singleProxy.port, 9150);
  const auth = env.listeners.auth.fn({
    isProxy: true,
    url: "http://example.onion/secret",
    tabId: 4,
    challenger: { host: "127.0.0.1", port: 9150 },
  }, () => {});
  assert.match(auth.authCredentials.username, /example\.onion/);
  const other = env.listeners.auth.fn({
    isProxy: true,
    url: "https://news.example/",
    tabId: 4,
    challenger: { host: "127.0.0.1", port: 9150 },
  }, () => {});
  assert.notEqual(other.authCredentials.username, auth.authCredentials.username);
  assert.equal(JSON.stringify(env.store).includes(auth.authCredentials.password), false);
});

test("a new circuit changes SOCKS auth and a dead Tor stays fail-closed", async () => {
  const before = env.listeners.auth.fn({
    isProxy: true, url: "https://news.example/", tabId: 1, challenger: { host: "127.0.0.1", port: 9150 },
  }, () => {});
  const circuit = await fromPopup({ type: "newCircuit" });
  assert.equal(circuit.generation > 1, true);
  const after = env.listeners.auth.fn({
    isProxy: true, url: "https://news.example/", tabId: 1, challenger: { host: "127.0.0.1", port: 9150 },
  }, () => {});
  assert.notEqual(before.authCredentials.password, after.authCredentials.password);
  const sets = env.calls.proxySet.length;
  const clears = env.calls.proxyClear;
  await env.listeners.proxyError();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(env.calls.proxyClear, clears);
  assert.equal(env.calls.proxySet.length, sets);
  const state = await fromPopup({ type: "getState" });
  assert.equal(state.tor.status, "unreachable");
  assert.equal(state.torEnabled, true);
});

test("the Tor check reads check.torproject.org and does not fall open on failure", async () => {
  mockFetch([{ match: "check.torproject.org/api/ip", status: 200, body: { IsTor: true, IP: "192.0.2.55" } }]);
  const ok = await fromPopup({ type: "checkTor" });
  assert.equal(ok.isTor, true);
  assert.equal(ok.status, "tor");
  mockFetch([{ match: "check.torproject.org/api/ip", throw: true }]);
  const down = await fromPopup({ type: "checkTor" });
  assert.equal(down.status, "unreachable");
  assert.equal((await fromPopup({ type: "getState" })).torEnabled, true);
  assert.equal(env.calls.proxySet.at(-1).value.rules.singleProxy.scheme, "socks5");
});

test("a missing VEIL plan does not remove the Tor route", async () => {
  await fromPopup({ type: "switchWorkspace", to: "authenticated", confirmed: true });
  const clears = env.calls.proxyClear;
  mockFetch([{ match: "/api/veil/session", status: 403, body: { error: "veil_plan_required" } }]);
  const response = await fromPopup({ type: "refreshVeil" });
  assert.match(response.error, /no VEIL entitlement/);
  assert.equal(env.calls.proxyClear, clears);
  assert.equal((await fromPopup({ type: "getState" })).tor.mode, "on");
});

test("turning Tor off is the explicit return to a direct connection", async () => {
  const response = await fromPopup({ type: "toggleTor", enabled: false });
  assert.equal(response.enabled, false);
  assert.equal(env.calls.webrtc.at(-1), "cleared");
  const state = await fromPopup({ type: "getState" });
  assert.equal(state.torEnabled, false);
  assert.equal(state.tor.status, "off");
});
