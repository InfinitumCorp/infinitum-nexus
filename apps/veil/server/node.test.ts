import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { serveNodeVeil } from "./node.ts";
import { veilFixture } from "./testing.ts";

test("the node adapter uses the configured origin and the CID host cookie", async () => {
  const fx = await veilFixture();
  const user = await fx.login(true);
  const server: Server = createServer((req, res) => {
    void serveNodeVeil(req, res, fx.control, "http://127.0.0.1:9");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/api/veil/session`, { headers: { "x-veil": "1" } });
    assert.equal(denied.status, 401);
    const ok = await fetch(`http://127.0.0.1:${port}/api/veil/session`, {
      headers: { "x-veil": "1", cookie: `spctr_session=${user.token}` },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.entitled, true);
    assert.equal(body.deviceWide, false);
    assert.equal(JSON.stringify(body).includes("password"), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a missing control plane fails closed", async () => {
  const server: Server = createServer((req, res) => {
    void serveNodeVeil(req, res, undefined, "http://localhost");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/veil/session`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).deviceWide, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
