import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./testing.ts";
import { fakeEngine } from "../../conjure/src/engine-testing.ts";
import { ConjureService } from "./service.ts";
import { conjureBackend } from "./backend.ts";
import { ConjureForecaster } from "@infinitum/conjure/forecaster";
async function fixture() {
  const s = await setup(),
    f = fakeEngine(),
    service = new ConjureService(s.auth, {
      engine: f.client,
      entitled: () => true,
      integrityKey: Buffer.alloc(32, 1),
    }),
    handler = conjureBackend(service),
    call = (body: unknown, headers: Record<string, string> = {}) =>
      handler(
        new Request("https://planner.example/api/predict/firm", {
          method: "POST",
          headers: {
            authorization: `Bearer ${s.owner.token}`,
            "content-type": "application/json",
            ...headers,
          },
          body: JSON.stringify(body),
        }),
      );
  return { ...s, ...f, handler, call };
}
test("forecaster start/advance/resume uses server-owned signed jobs, never caller-supplied upstream state", async () => {
  const s = await fixture(),
    client = new ConjureForecaster({
      origin: "https://planner.example",
      token: () => s.owner.token,
      fetch: async (url, init) => s.handler(new Request(url, init)),
    });
  const result = await client.start<any>("firm", {
    repo: s.owner.repo,
    id: "test",
    expectedHead: null,
    source: { kind: "storage" },
    consent: true,
  });
  assert.equal(result.model, "CONJURE");
  const next = await client.advance<any>(
    "firm",
    s.owner.repo,
    "test",
    result.commit.id,
  );
  assert.equal(next.step, "graph_build");
  assert.equal(
    (await client.resume<any>("firm", s.owner.repo, "test")).step,
    "graph_build",
  );
  assert.equal(s.calls.length, 1);
});
test("no cookie-only auth, cross-origin access, compressed bodies or arbitrary questions/jobs", async () => {
  const s = await fixture(),
    data = {
      action: "create",
      repo: s.owner.repo,
      id: "test",
      expectedHead: null,
      source: { kind: "storage" },
      consent: true,
    };
  assert.equal(
    (
      await s.handler(
        new Request("https://planner.example/api/predict/firm", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: `cid_session=${s.owner.token}`,
          },
          body: JSON.stringify(data),
        }),
      )
    ).status,
    401,
  );
  assert.equal(
    (await s.call(data, { origin: "https://attacker.example" })).status,
    403,
  );
  assert.equal(
    (await s.call(data, { "content-encoding": "gzip" })).status,
    415,
  );
  assert.equal(
    (await s.call({ ...data, question: "identified-person" })).status,
    400,
  );
  assert.equal(
    (await s.call({ ...data, job: { ids: { project_id: "other" } } })).status,
    400,
  );
  assert.equal(s.calls.length, 0);
});
test("bounded JSON, path products, live plans and no-store errors fail closed", async () => {
  const s = await fixture();
  assert.equal((await s.call({ data: "a".repeat(65536) })).status, 413);
  assert.equal(
    (await s.handler(new Request("https://planner.example/api/predict/throne")))
      .status,
    404,
  );
  const r = await s.call({
    action: "load",
    repo: s.owner.repo,
    id: "../secret",
  });
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.ok(!(await r.text()).includes("secret"));
  s.setPaid(false);
  assert.equal(
    (await s.call({ action: "load", repo: s.owner.repo, id: "test" })).status,
    403,
  );
});
