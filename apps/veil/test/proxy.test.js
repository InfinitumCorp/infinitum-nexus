import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WEBRTC_POLICY,
  bypassHostsFor,
  chromeFailClosed,
  chromeFixedServers,
  failClosedFirefox,
  failClosedPac,
  firefoxProxyInfo,
  isDirectHost,
  normalizeServer,
  selectServer,
} from "../lib/proxy.js";

const httpsServer = { id: "iad-1", name: "Washington", region: "us-east", host: "Veil-IAD.Example", port: 443, scheme: "https" };
const socksServer = { id: "lhr-1", name: "London", region: "eu-west", host: "veil-lhr.example", port: 1080, scheme: "socks5" };

test("only https and socks5 exits survive, and DNS-leaking schemes do not", () => {
  assert.equal(normalizeServer(httpsServer).host, "veil-iad.example");
  assert.equal(firefoxProxyInfo(socksServer).proxyDNS, true);
  assert.equal(firefoxProxyInfo(socksServer).password, undefined);
  assert.equal(firefoxProxyInfo(httpsServer).type, "https");
  assert.deepEqual(chromeFixedServers(socksServer, ["localhost"]).rules.singleProxy, {
    scheme: "socks5", host: "veil-lhr.example", port: 1080,
  });
  for (const scheme of ["socks4", "socks", "http", "direct", "quic"]) {
    assert.throws(() => normalizeServer({ ...httpsServer, scheme }), /scheme/, scheme);
  }
  assert.throws(() => normalizeServer({ ...httpsServer, host: "user:pass@veil.example" }), /host/);
  assert.throws(() => normalizeServer({ ...httpsServer, host: "169.254.169.254" }), /host/);
  assert.throws(() => normalizeServer({ ...httpsServer, port: "443" }), /port/);
});

test("fail-closed PAC blocks with dead SOCKS5 and does not inject a bypass", () => {
  const pac = failClosedPac(["cid.example", '"); return "DIRECT";', "localhost"]);
  assert.match(pac, /SOCKS5 127\.0\.0\.1:1/);
  assert.doesNotMatch(pac, /return "DIRECT";'/);
  assert.match(pac, /"cid.example"/);
  assert.equal(chromeFailClosed(["localhost"]).mode, "pac_script");
  assert.equal(failClosedFirefox().proxyDNS, true);
  assert.equal(failClosedFirefox().port, 1);
  assert.equal(WEBRTC_POLICY, "disable_non_proxied_udp");
});

test("control hosts bypass the proxy and other destinations do not", () => {
  const hosts = bypassHostsFor({ cid: "http://localhost:3000", veil: "https://cid.example/ignored" });
  assert.ok(hosts.includes("localhost"));
  assert.ok(hosts.includes("cid.example"));
  assert.equal(isDirectHost("CID.Example", hosts), true);
  assert.equal(isDirectHost("example.com", hosts), false);
  assert.equal(selectServer([httpsServer, socksServer], "lhr-1").chosen.scheme, "socks5");
  assert.throws(() => selectServer([httpsServer], "nope"), /Select/);
});
