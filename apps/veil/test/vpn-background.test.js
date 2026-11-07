import { test, before } from "node:test";
import assert from "node:assert/strict";
import { fakeChrome } from "./fake-chrome.js";

const env = fakeChrome();
env.chrome.runtime.onStartup = { addListener: (fn) => { env.listeners.startup = fn; } };
env.chrome.proxy.onProxyError = { addListener: (fn) => { env.listeners.proxyError = fn; } };
env.chrome.webRequest = {
  onAuthRequired: { addListener: (fn, filter, extra) => { env.listeners.auth = { fn, filter, extra }; } },
};
globalThis.chrome = env.chrome;
const fromPopup = (msg) => env.send(msg, { id: "veilid", url: "chrome-extension://veilid/popup.html" });
const fromPage = (msg) => env.send(msg, { id: "veilid", url: "https://example.com/", tab: { id: 1, windowId: 1, active: true } });

const grant = {
  coverage: "browser",
  deviceWide: false,
  dns: "through-proxy",
  server: { id: "iad-1", name: "Washington", region: "us-east", host: "veil-iad.example", port: 443, scheme: "https" },
  auth: { username: "v_username_ok", password: "0123456789abcdefEXTRA", expiresAt: "2099-01-01T00:00:00Z" },
};
const session = {
  cid: "cid_1", username: "alex", entitled: true, browserOnly: true, deviceWide: false,
  servers: [grant.server],
};

function mockFetch(routes) {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    const hit = routes.find((route) => String(url).includes(route.match));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: hit.status < 400, status: hit.status, json: async () => hit.body };
  };
  return seen;
}

before(async () => {
  await import("../background.js");
  await env.listeners.installed[0]();
});

test("a page cannot connect or disconnect the proxy", async () => {
  for (const type of ["connectVeil", "disconnectVeil", "refreshVeil"]) {
    const response = await fromPage({ type, serverId: "iad-1" });
    assert.match(response.error, /not allowed/, type);
  }
  assert.equal(env.calls.proxySet.length, 0);
});

test("anonymous workspace cannot fetch a proxy grant", async () => {
  const seen = mockFetch([]);
  const response = await fromPopup({ type: "connectVeil", serverId: "iad-1" });
  assert.match(response.error, /anonymous/);
  assert.equal(seen.length, 0);
});

test("connect applies the authenticated proxy and keeps the password out of storage", async () => {
  await fromPopup({ type: "switchWorkspace", to: "authenticated", confirmed: true });
  const seen = mockFetch([
    { match: "/api/veil/connect", status: 200, body: grant },
  ]);
  const response = await fromPopup({ type: "connectVeil", serverId: "iad-1" });
  assert.equal(response.error, undefined);
  assert.equal(response.veil.mode, "connected");
  assert.equal(response.veil.deviceWide, false);
  assert.equal(seen[0].opts.credentials, "include");
  assert.equal(seen[0].url, "http://localhost:3000/api/veil/connect");
  const applied = env.calls.proxySet.at(-1).value;
  assert.equal(applied.mode, "fixed_servers");
  assert.deepEqual(applied.rules.singleProxy, { scheme: "https", host: "veil-iad.example", port: 443 });
  assert.ok(applied.rules.bypassList.includes("localhost"));
  assert.equal(env.calls.webrtc.at(-1), "disable_non_proxied_udp");
  assert.equal(env.listeners.auth.extra[0], "asyncBlocking");
  const stored = JSON.stringify(env.store);
  assert.equal(stored.includes(grant.auth.password), false);
  assert.equal(stored.includes("0123456789abcdef"), false);
  assert.equal(env.store.veilStatus, "connected");
});

test("Tor and VEIL cannot own the proxy together", async () => {
  const response = await fromPopup({ type: "toggleTor", enabled: true });
  assert.match(response.error, /Disconnect VEIL/);
  await fromPopup({ type: "disconnectVeil" });
  assert.equal(env.store.veilStatus, "off");
  assert.equal(env.calls.proxyClear >= 1, true);
  await fromPopup({ type: "toggleTor", enabled: true });
  const blocked = await fromPopup({ type: "connectVeil", serverId: "iad-1" });
  assert.match(blocked.error, /Turn off Tor/);
  await fromPopup({ type: "toggleTor", enabled: false });
});

test("a dropped proxy fails closed, and an explicit disconnect browses directly again", async () => {
  mockFetch([{ match: "/api/veil/connect", status: 200, body: grant }]);
  await fromPopup({ type: "connectVeil", serverId: "iad-1" });
  const before = env.calls.proxySet.length;
  await env.listeners.proxyError();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(env.calls.proxySet.length > before, true);
  assert.equal(env.calls.proxySet.at(-1).value.mode, "pac_script");
  assert.match(env.calls.proxySet.at(-1).value.pacScript.data, /SOCKS5 127\.0\.0\.1:1/);
  assert.equal(env.store.veilStatus, "fail-closed");
  mockFetch([{ match: "/api/veil/disconnect", status: 200, body: { ok: true } }]);
  const off = await fromPopup({ type: "disconnectVeil" });
  assert.equal(off.veil.mode, "off");
  assert.equal(env.store.veilStatus, "off");
});

test("startup with a saved connection blocks until a new grant is issued", async () => {
  env.store.veilStatus = "connected";
  env.store.veilServerId = "iad-1";
  const seen = mockFetch([{ match: "/api/veil/connect", status: 200, body: grant }]);
  await env.listeners.startup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(seen.at(-1).url.endsWith("/api/veil/connect"), true);
  assert.equal(env.store.veilStatus, "connected");
  assert.equal(env.calls.proxySet.at(-1).value.mode, "fixed_servers");
  assert.equal(JSON.stringify(env.store).includes(grant.auth.password), false);
});

test("a missing VEIL plan does not configure a proxy", async () => {
  await fromPopup({ type: "disconnectVeil" });
  const sets = env.calls.proxySet.length;
  mockFetch([{ match: "/api/veil/connect", status: 403, body: { error: "veil_plan_required" } }]);
  const response = await fromPopup({ type: "connectVeil", serverId: "iad-1" });
  assert.match(response.error, /no VEIL entitlement/);
  assert.equal(env.calls.proxySet.length, sets);
  assert.equal(env.store.veilStatus, "off");
});
