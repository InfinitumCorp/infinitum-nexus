import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_URL,
  chromeTorSettings,
  endpointLabel,
  failClosedFirefox,
  firefoxTorProxy,
  isLoopback,
  isOnion,
  normalizeTorEndpoint,
  parseTorCheck,
  socksIsolation,
} from "../lib/proxy.js";

test("the default client is local SOCKS5 on 9050 and Tor Browser is 9150", () => {
  assert.deepEqual(normalizeTorEndpoint(), { host: "127.0.0.1", port: 9050, scheme: "socks5" });
  assert.equal(normalizeTorEndpoint({ port: 9150 }).port, 9150);
  assert.match(endpointLabel({ port: 9150 }), /Tor Browser/);
  assert.throws(() => normalizeTorEndpoint({ host: "veil.example", port: 9050 }), /local Tor/);
  assert.throws(() => normalizeTorEndpoint({ port: 0 }), /port/);
  const settings = chromeTorSettings({ port: 9050 });
  assert.deepEqual(settings.rules.singleProxy, { scheme: "socks5", host: "127.0.0.1", port: 9050 });
  assert.deepEqual(settings.rules.bypassList, ["localhost", "127.0.0.1", "[::1]"]);
  assert.equal(settings.rules.bypassList.some((host) => host.includes("onion")), false);
});

test("SOCKS isolation differs by site, tab, and identity, and keeps .onion names intact", () => {
  const first = socksIsolation("https://news.example/a", "identity_one", 3);
  const other = socksIsolation("https://mail.example/a", "identity_one", 3);
  const tab = socksIsolation("https://news.example/a", "identity_one", 4);
  const again = socksIsolation("https://news.example/a", "identity_two", 3);
  const onion = socksIsolation("http://example.onion/hidden", "identity_one", 3);
  assert.notEqual(first.username, other.username);
  assert.notEqual(first.password, tab.password);
  assert.notEqual(first.password, again.password);
  assert.match(onion.username, /example\.onion/);
  assert.equal(isOnion("example.onion"), true);
  assert.equal(isLoopback("example.onion"), false);
  assert.equal(first.username.length <= 255 && first.password.length <= 255, true);
  const firefox = firefoxTorProxy({ port: 9150 }, first);
  assert.equal(firefox.proxyDNS, true);
  assert.equal(firefox.type, "socks");
  assert.equal(firefox.failoverTimeout, undefined);
  assert.equal(firefox.username, first.username);
  assert.equal(failClosedFirefox().proxyDNS, true);
  assert.equal(failClosedFirefox().port, 1);
});

test("the Tor check accepts only a boolean IsTor", () => {
  assert.equal(CHECK_URL, "https://check.torproject.org/api/ip");
  assert.deepEqual(parseTorCheck({ IsTor: true, IP: "192.0.2.20" }), { isTor: true, ip: "192.0.2.20", error: null });
  assert.equal(parseTorCheck({ IsTor: "true" }).isTor, false);
  assert.equal(parseTorCheck(null).isTor, false);
});
