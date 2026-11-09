import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createJob,
  advanceJob,
  conjureClient,
  UpstreamError,
} from "./engine.ts";
import { fakeEngine } from "./engine-testing.ts";
const fresh = () =>
  createJob({
    question: "What technical uncertainties remain?",
    seed: "Aggregate archived measurements only: requests=100; failures=2; no people or positions.",
    rounds: 5,
  }).job!;
test("ported CONJURE advances exactly one real-contract request per step through every stage", async () => {
  const f = fakeEngine();
  let job = fresh(),
    progress = 0;
  for (let n = 0; job.status === "running" && n < 20; n++) {
    const before = f.calls.length;
    job = await advanceJob(job, f.client);
    assert.equal(f.calls.length, before + 1);
    assert.ok(job.progress >= progress);
    progress = job.progress;
  }
  assert.equal(job.status, "completed");
  assert.equal(job.step, "done");
  assert.equal(job.progress, 100);
  assert.match(job.report!, /Qualitative/);
  assert.equal(f.calls.length, 11);
});
test("upstream IDs cannot become URL paths", async () => {
  const f = fakeEngine(() =>
    Response.json({ success: true, data: { project_id: "../../private" } }),
  );
  const job = await advanceJob(fresh(), f.client);
  assert.equal(job.status, "failed");
  assert.equal(f.calls.length, 1);
  assert.throws(() => f.client.runStatus("../x"));
});
test("unsafe origins are rejected; explicit engine token is not sent through redirects or cookies", async () => {
  for (const baseUrl of [
    "http://engine.example",
    "https://u:pass@engine.example",
    "https://engine.example/path",
    "https://engine.example?x=1",
  ])
    assert.throws(() => conjureClient({ baseUrl }));
  const f = fakeEngine();
  await advanceJob(fresh(), f.client);
  assert.equal(f.calls[0]!.init.credentials, "omit");
  assert.equal(f.calls[0]!.init.redirect, "error");
});
test("kick-off failures are not blindly retried and errors do not reflect upstream details", async () => {
  const f = fakeEngine(() =>
    Response.json({ success: false, error: "must-not-echo" }, { status: 502 }),
  );
  const job = await advanceJob(fresh(), f.client);
  assert.equal(job.status, "failed");
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(job).includes("must-not-echo"));
});
test("poll retries are bounded, leave IDs stable, and terminate after five failures", async () => {
  const f = fakeEngine((path) =>
    path.includes("/task/") ? new Response("down", { status: 503 }) : undefined,
  );
  let job = await advanceJob(await advanceJob(fresh(), f.client), f.client);
  for (let i = 0; i < 5; i++) job = await advanceJob(job, f.client);
  assert.equal(job.status, "failed");
  assert.equal(job.failures, 5);
  assert.equal(f.calls.length, 7);
});
test("engine response sizes, malformed JSON and stream failures are bounded and sanitized", async () => {
  for (const response of [
    new Response("x".repeat(1048577), {
      headers: { "content-type": "application/json" },
    }),
    new Response("not-json", {
      headers: { "content-type": "application/json" },
    }),
    new Response("{}", { headers: { "content-type": "text/html" } }),
  ]) {
    const c = conjureClient({
      baseUrl: "https://engine.example",
      fetchImpl: async () => response,
    });
    await assert.rejects(() => c.task("safe"), UpstreamError);
  }
});
test("create keeps source limits and provides no demo fallback", () => {
  assert.ok(createJob({ question: "", seed: "x" }).error);
  assert.ok(createJob({ question: "x", seed: "short" }).error);
  assert.equal(
    createJob({ question: "x", seed: "a".repeat(100), rounds: 400 }).job
      ?.rounds,
    40,
  );
});

test("untrusted run counters cannot reflect strings or nonfinite values in workflow metadata", async () => {
  const f = fakeEngine((path) =>
    path.includes("/run-status")
      ? Response.json({
          success: true,
          data: {
            runner_status: "completed",
            current_round: "must-not-echo",
            total_actions_count: -1,
          },
        })
      : undefined,
  );
  let job = fresh();
  for (let n = 0; n < 20 && job.status === "running"; n++)
    job = await advanceJob(job, f.client);
  assert.equal(job.status, "completed");
  assert.ok(!JSON.stringify(job.stats).includes("must-not-echo"));
  assert.equal(job.stats?.actions, null);
});
