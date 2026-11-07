import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchBridges, fetchSession } from "../lib/veil-api.js";

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("session fetch uses the CID cookie and ignores a stringly entitled flag", async () => {
  const seen = [];
  const fetcher = async (url, opts) => {
    seen.push({ url, opts });
    return jsonResponse(200, {
      cid: "cid_1", username: "alex", entitled: "true", browserOnly: true, deviceWide: false, routing: "local-tor",
      bridges: ["bridge 192.0.2.10:443"],
    });
  };
  const session = await fetchSession("http://localhost:3000/path", fetcher);
  assert.equal(seen[0].url, "http://localhost:3000/api/veil/session");
  assert.equal(seen[0].opts.credentials, "include");
  assert.equal(seen[0].opts.method, "GET");
  assert.equal(session.entitled, false);
  assert.equal(session.routing, "local-tor");
  assert.equal(JSON.stringify(session).includes("192.0.2.10"), false);
});

test("bridges are a separate premium read and are not a route", async () => {
  const seen = [];
  const fetcher = async (url, opts) => {
    seen.push({ url, opts });
    return jsonResponse(200, { bridges: ["bridge obfs4 192.0.2.10:443 FINGERPRINT"], optional: true, routing: "local-tor" });
  };
  const bridges = await fetchBridges("https://cid.example", fetcher);
  assert.equal(seen[0].url, "https://cid.example/api/veil/bridges");
  assert.equal(bridges.length, 1);
  await assert.rejects(() => fetchBridges("http://evil.example", fetcher), /localhost/);
  const denied = async () => jsonResponse(403, { error: "veil_plan_required" });
  await assert.rejects(() => fetchBridges("http://127.0.0.1:3000", denied), /no VEIL entitlement/);
});
