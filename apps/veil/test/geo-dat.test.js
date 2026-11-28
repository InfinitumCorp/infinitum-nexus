import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BLOCKED_HOSTS, blocklistRules, isBlockedHost } from "../lib/blocklist.js";
import { bypassForRoute, blocklistWithGeo, extraGeoHosts } from "../lib/geo-dat.js";
import { chromeTorSettings } from "../lib/proxy.js";

function concat(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function varint(value) {
  const bytes = [];
  let n = value >>> 0;
  while (n > 127) {
    bytes.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  bytes.push(n);
  return Uint8Array.from(bytes);
}
function key(field, wire) { return varint((field << 3) | wire); }
function bytesField(field, payload) {
  const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  return concat([key(field, 2), varint(body.length), body]);
}
function varintField(field, value) { return concat([key(field, 0), varint(value)]); }
function domain(kind, value) { return bytesField(2, concat([varintField(1, kind), bytesField(2, value)])); }
function site(code, domains) { return bytesField(1, concat([bytesField(1, code), ...domains])); }

const geosite = site("category-ads", [domain(2, "tracker.example")]) 
  instanceof Uint8Array
  ? concat([
      site("category-ads", [domain(2, "tracker.example")]),
      site("direct", [domain(2, "direct.example"), domain(3, "hidden.onion"), domain(2, "also.onion.")]),
    ])
  : new Uint8Array();

test("the extension decoder matches the shared package decoder", () => {
  const shared = readFileSync(new URL("../../../packages/geo-dat/src/decode.js", import.meta.url), "utf8");
  const local = readFileSync(new URL("../lib/geo-decode.js", import.meta.url), "utf8");
  assert.equal(local, shared);
});

test("geo categories add hosts and do not replace the curated blocklist", () => {
  assert.deepEqual(blocklistWithGeo({ enabled: false, geosite, categories: ["category-ads"] }).map((rule) => rule.category), blocklistRules().map((rule) => rule.category));
  const offHosts = blocklistWithGeo().flatMap((rule) => rule.condition.requestDomains);
  assert.deepEqual([...offHosts].sort(), [...BLOCKED_HOSTS]);
  const on = blocklistWithGeo({ enabled: true, geosite, categories: ["category-ads"] });
  const hosts = on.flatMap((rule) => rule.condition.requestDomains);
  assert.ok(hosts.includes("doubleclick.net"));
  assert.ok(hosts.includes("tracker.example"));
  assert.equal(hosts.length, BLOCKED_HOSTS.length + 1);
  assert.equal(isBlockedHost("doubleclick.net"), true);
  assert.deepEqual(extraGeoHosts(geosite, ["category-ads"]), ["tracker.example"]);
});

test("onion names are never a bypass, and Tor ignores geosite bypasses", () => {
  const extra = extraGeoHosts(geosite, ["direct"], { bypass: true });
  assert.deepEqual(extra, ["direct.example"]);
  const base = ["localhost", "127.0.0.1", "[::1]"];
  assert.deepEqual(bypassForRoute("tor", true, [...base, "hidden.onion"], extra), base);
  assert.deepEqual(bypassForRoute("veil", false, base, extra), base);
  const veil = bypassForRoute("veil", true, [...base, "hidden.onion", "direct.example"], extra);
  assert.ok(veil.includes("direct.example"));
  assert.equal(veil.some((host) => String(host).includes("onion")), false);
  assert.equal(chromeTorSettings().rules.bypassList.some((host) => host.includes("onion")), false);
});
