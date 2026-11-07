import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSession, parseConnectGrant, parseSession, postConnect, postDisconnect } from "../lib/veil-api.js";

const server = { id: "iad-1", name: "Washington", region: "us-east", host: "veil-iad.example", port: 443, scheme: "https" };

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("session fetch uses the CID cookie and ignores a stringly entitled flag", async () => {
  const seen = [];
  const fetcher = async (url, opts) => {
    seen.push({ url, opts });
    return jsonResponse(200, {
      cid: "cid_1", username: "alex", entitled: "true", browserOnly: true, deviceWide: false,
      servers: [{ ...server, password: "should-not-stick" }], auth: { password: "nope" },
    });
  };
  const session = await fetchSession("http://localhost:3000/path", fetcher);
  assert.equal(seen[0].url, "http://localhost:3000/api/veil/session");
  assert.equal(seen[0].opts.credentials, "include");
  assert.equal(seen[0].opts.redirect, "error");
  assert.equal(seen[0].opts.headers["x-veil"], "1");
  assert.equal(session.entitled, false);
  assert.deepEqual(session.servers, []);
  assert.equal(JSON.stringify(session).includes("password"), false);
});

test("connect parses a browser-only grant and refuses expired, device-wide, or socks4 responses", async () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const grant = parseConnectGrant({
    coverage: "browser", deviceWide: false, dns: "through-proxy", server,
    auth: { username: "v_username", password: "0123456789abcdef", expiresAt: "2026-11-07T12:15:00Z" },
  }, now);
  assert.equal(grant.server.scheme, "https");
  assert.equal(grant.deviceWide, false);
  assert.throws(() => parseConnectGrant({ ...grant, deviceWide: true }, now), /browser-only/);
  assert.throws(() => parseConnectGrant({
    coverage: "browser", deviceWide: false, dns: "through-proxy", server,
    auth: { username: "v_username", password: "0123456789abcdef", expiresAt: "2020-01-01T00:00:00Z" },
  }, now), /expired/);
  assert.throws(() => parseSession({ cid: "cid_1", entitled: true, browserOnly: true, deviceWide: false, servers: [{ ...server, scheme: "socks4" }] }), /scheme/);
  const seen = [];
  const fetcher = async (url, opts) => {
    seen.push({ url, opts });
    return jsonResponse(200, {
      coverage: "browser", deviceWide: false, dns: "through-proxy", server,
      auth: { username: "v_username", password: "0123456789abcdef", expiresAt: "2099-01-01T00:00:00Z" },
    });
  };
  const connected = await postConnect("https://cid.example", "iad-1", fetcher, now);
  assert.equal(seen[0].opts.method, "POST");
  assert.equal(seen[0].opts.credentials, "include");
  assert.deepEqual(JSON.parse(seen[0].opts.body), { serverId: "iad-1" });
  assert.equal(connected.auth.password, "0123456789abcdef");
  await assert.rejects(() => postConnect("https://cid.example", "../admin", fetcher), /Select/);
  await assert.rejects(() => postConnect("http://evil.example", "iad-1", fetcher), /localhost/);
});

test("a missing plan is a 403 and disconnect still presents the session cookie", async () => {
  const fetcher = async () => jsonResponse(403, { error: "veil_plan_required" });
  await assert.rejects(() => fetchSession("http://127.0.0.1:3000", fetcher), /no VEIL entitlement/);
  let method = "";
  await postDisconnect("http://localhost:3000", async (_url, opts) => {
    method = opts.method;
    assert.equal(opts.credentials, "include");
    return jsonResponse(200, { ok: true });
  });
  assert.equal(method, "POST");
});
