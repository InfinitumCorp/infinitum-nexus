import { test } from "node:test";
import assert from "node:assert/strict";
import { veilHttp } from "./http.ts";
import { veilFixture, VEIL_BRIDGES } from "./testing.ts";

async function call(
  handler: (request: Request) => Promise<Response>,
  path: string,
  opts: { token?: string; cookie?: string; method?: string; headers?: Record<string, string> } = {},
) {
  const headers = new Headers({ "x-veil": "1", ...(opts.headers ?? {}) });
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  const response = await handler(new Request(`https://cid.example${path}`, { method: opts.method ?? "GET", headers }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null, text };
}

test("HTTP requires the Cumulus ID session and does not treat another cookie as login", async () => {
  const fx = await veilFixture();
  const user = await fx.login(true);
  const handler = veilHttp(fx.control);
  assert.equal((await call(handler, "/api/veil/session")).status, 401);
  assert.equal((await call(handler, "/api/veil/session", { cookie: `other=${user.token}` })).status, 401);
  assert.equal((await call(handler, "/api/veil/session", {
    cookie: `spctr_session=${user.token}`,
    headers: { authorization: "Bearer" },
  })).status, 401);
  const cookie = await call(handler, "/api/veil/session", { cookie: `spctr_session=${encodeURIComponent(user.token)}` });
  assert.equal(cookie.status, 200);
  assert.equal(cookie.body?.entitled, true);
  assert.equal(cookie.body?.routing, "local-tor");
  assert.equal(cookie.body?.deviceWide, false);
  assert.equal(cookie.text.includes("password"), false);
  assert.equal(cookie.text.includes("192.0.2.10"), false);
});

test("bridges are premium and connect no longer issues an exit credential", async () => {
  const fx = await veilFixture();
  const user = await fx.login(false);
  const handler = veilHttp(fx.control);
  const denied = await call(handler, "/api/veil/bridges", { token: user.token });
  assert.equal(denied.status, 403);
  assert.equal(denied.body?.error, "veil_plan_required");
  assert.equal(denied.text.includes("192.0.2.10"), false);
  fx.entitled.add(user.account.cid);
  const headerless = await call(handler, "/api/veil/bridges", { token: user.token, headers: { "x-veil": "" } });
  assert.equal(headerless.status, 403);
  const ok = await call(handler, "/api/veil/bridges", { token: user.token });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body?.bridges, VEIL_BRIDGES);
  assert.equal(ok.body?.optional, true);
  assert.equal(ok.body?.routing, "local-tor");
  assert.equal((await call(handler, "/api/veil/connect", { token: user.token, method: "POST" })).status, 404);
});

test("query strings are not found", async () => {
  const fx = await veilFixture();
  const handler = veilHttp(fx.control);
  assert.equal((await call(handler, "/api/veil/session?token=1")).status, 404);
});
