import { test } from "node:test";
import assert from "node:assert/strict";
import { OrbitalClient } from "./client.ts";
test("client uses explicit bearer with no cookies, redirects, cache or referrer", async () => {
  let captured: RequestInit | undefined,
    target = "";
  const client = new OrbitalClient({
    origin: "https://planner.example",
    token: () => "test-only-credential",
    fetch: async (url, init) => {
      target = String(url);
      captured = init;
      return Response.json({ simulationOnly: true });
    },
  });
  assert.deepEqual(
    await client.request("firmament", {
      action: "load",
      repo: "r1",
      commit: "a".repeat(64),
      path: "orbital/elements/example.json",
    }),
    { simulationOnly: true },
  );
  assert.equal(target, "https://planner.example/api/orbital/firmament");
  assert.equal(captured?.credentials, "omit");
  assert.equal(captured?.redirect, "error");
  assert.equal(captured?.cache, "no-store");
  assert.equal(captured?.referrerPolicy, "no-referrer");
  assert.equal(
    new Headers(captured?.headers).get("authorization"),
    "Bearer test-only-credential",
  );
});
test("client rejects insecure remote origins, URL credentials, query fragments and paths", () => {
  for (const origin of [
    "http://example.com",
    "https://user:secret@example.com",
    "https://example.com/path",
    "https://example.com?x=1",
    "https://example.com/#x",
    "file:///tmp/test",
  ])
    assert.throws(() => new OrbitalClient({ origin, token: () => "x" }));
  assert.ok(
    new OrbitalClient({ origin: "http://localhost:4000", token: () => "x" }),
  );
});
test("client bounds requests and validates product and tokens before network I/O", async () => {
  let calls = 0;
  const client = new OrbitalClient({
    origin: "https://planner.example",
    token: () => "x",
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  await assert.rejects(() => client.request("throne" as never, {}));
  await assert.rejects(() =>
    client.request("orbis", { data: "a".repeat(65536) }),
  );
  assert.equal(calls, 0);
  const bad = new OrbitalClient({
    origin: "https://planner.example",
    token: () => "with whitespace",
    fetch: async () => {
      calls++;
      return Response.json({});
    },
  });
  await assert.rejects(() => bad.request("orbis", {}));
  assert.equal(calls, 0);
});
test("client never exposes server error bodies or transport details", async () => {
  const denied = new OrbitalClient({
    origin: "https://planner.example",
    token: () => "x",
    fetch: async () => new Response("sensitive-server-debug", { status: 403 }),
  });
  await assert.rejects(() => denied.request("orbis", {}), {
    message: "Orbital request denied (403)",
  });
  const failed = new OrbitalClient({
    origin: "https://planner.example",
    token: () => "x",
    fetch: async () => {
      throw new Error("sensitive-transport-debug");
    },
  });
  await assert.rejects(() => failed.request("orbis", {}), {
    message: "Orbital transport failed",
  });
});
test("client bounds streamed responses and refuses wrong content types or invalid JSON", async () => {
  for (const response of [
    new Response("{}", { headers: { "content-type": "text/html" } }),
    new Response("sensitive-not-json", {
      headers: { "content-type": "application/json" },
    }),
    new Response("a".repeat(2097153), {
      headers: { "content-type": "application/json" },
    }),
  ]) {
    const client = new OrbitalClient({
      origin: "https://planner.example",
      token: () => "x",
      fetch: async () => response,
    });
    await assert.rejects(() => client.request("orbis", {}));
  }
});

test("client sanitizes response-stream failures", async () => {
  const client = new OrbitalClient({
    origin: "https://planner.example",
    token: () => "x",
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("sensitive-stream-debug"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  await assert.rejects(() => client.request("orbis", {}), {
    message: "Invalid orbital response",
  });
});
