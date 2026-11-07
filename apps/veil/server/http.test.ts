import { test } from "node:test";
import assert from "node:assert/strict";
import { veilHttp } from "./http.ts";
import { veilFixture } from "./testing.ts";

async function call(
  handler: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  opts: { token?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const headers = new Headers({ "x-veil": "1", ...(opts.headers ?? {}) });
  if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const response = await handler(new Request(`https://cid.example${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  }));
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : null, text };
}

test("HTTP requires the Cumulus ID session and never treats a cookie name other than the host session as login", async () => {
  const fx = await veilFixture();
  const user = await fx.login(true);
  const handler = veilHttp(fx.control);
  assert.equal((await call(handler, "GET", "/api/veil/session")).status, 401);
  assert.equal((await call(handler, "GET", "/api/veil/session", { cookie: `other=${user.token}` })).status, 401);
  assert.equal((await call(handler, "GET", "/api/veil/session", {
    cookie: `spctr_session=${user.token}`,
    headers: { authorization: "Bearer" },
  })).status, 401);
  const cookie = await call(handler, "GET", "/api/veil/session", { cookie: `spctr_session=${encodeURIComponent(user.token)}` });
  assert.equal(cookie.status, 200);
  assert.equal(cookie.body?.entitled, true);
  assert.equal(cookie.body?.deviceWide, false);
  assert.equal(cookie.text.includes("password"), false);
  assert.equal((cookie.body?.servers as { host: string }[])[0].host, "veil-iad.example");
});

test("connect rejects extra fields, missing plan, and unknown servers; the password is issued once", async () => {
  const fx = await veilFixture();
  const user = await fx.login(false);
  const handler = veilHttp(fx.control);
  const denied = await call(handler, "POST", "/api/veil/connect", { token: user.token, body: { serverId: "iad-1" } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body?.error, "veil_plan_required");
  assert.equal(denied.text.includes("password"), false);
  fx.entitled.add(user.account.cid);
  const injected = await call(handler, "POST", "/api/veil/connect", {
    token: user.token,
    body: { serverId: "iad-1", host: "evil.example", password: "nope" },
  });
  assert.equal(injected.status, 400);
  const missing = await call(handler, "POST", "/api/veil/connect", { token: user.token, body: { serverId: "nope" } });
  assert.equal(missing.status, 404);
  const headerless = await call(handler, "POST", "/api/veil/connect", {
    token: user.token,
    body: { serverId: "iad-1" },
    headers: { "x-veil": "" },
  });
  assert.equal(headerless.status, 403);
  const ok = await call(handler, "POST", "/api/veil/connect", { token: user.token, body: { serverId: "lhr-1" } });
  assert.equal(ok.status, 200);
  const auth = ok.body?.auth as { username: string; password: string };
  assert.equal(ok.body?.coverage, "browser");
  assert.equal(ok.body?.deviceWide, false);
  assert.equal(ok.body?.dns, "through-proxy");
  assert.equal((ok.body?.server as { host: string }).host, "veil-lhr.example");
  assert.equal(fx.control.authorizeProxy(auth.username, auth.password), true);
  const listed = await call(handler, "GET", "/api/veil/servers", { token: user.token });
  assert.equal(listed.text.includes(auth.password), false);
  const bye = await call(handler, "POST", "/api/veil/disconnect", { token: user.token, body: {} });
  assert.equal(bye.status, 200);
  assert.equal(fx.control.authorizeProxy(auth.username, auth.password), false);
});

test("query strings and unknown paths are not found", async () => {
  const fx = await veilFixture();
  const handler = veilHttp(fx.control);
  assert.equal((await call(handler, "GET", "/api/veil/session?token=1")).status, 404);
  assert.equal((await call(handler, "GET", "/api/veil/admin")).status, 404);
});
