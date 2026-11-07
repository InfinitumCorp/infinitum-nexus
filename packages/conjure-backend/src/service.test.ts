import { orbitalBackend } from "@infinitum/orbital";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConjureService } from "./service.ts";
import { setup } from "./testing.ts";
import { CONJURE_PRODUCT_PRESETS } from "@infinitum/conjure";
import { ArchiveIngest } from "@infinitum/event-ingest";
import { fakeEngine } from "../../conjure/src/engine-testing.ts";
const input = (repo: string, extra: Record<string, unknown> = {}) => ({
  repo,
  id: "scenario",
  expectedHead: null,
  source: { kind: "storage" },
  consent: true,
  ...extra,
});
async function fixture() {
  const s = await setup(),
    f = fakeEngine(),
    service = new ConjureService(s.auth, {
      engine: f.client,
      entitled: () => true,
      integrityKey: Buffer.alloc(32, 7),
    });
  return { ...s, ...f, service };
}
test("actual CID snapshot feeds the ported CONJURE workflow with private signed CAS artifacts", async () => {
  const s = await fixture();
  let result = s.service.create(
    s.owner.token,
    "firmament",
    input(s.owner.repo),
  );
  assert.equal(s.calls.length, 0);
  assert.equal(result.model, "CONJURE");
  assert.equal(result.dataSaleAllowed, false);
  assert.ok(result.evidence.metrics.orgLimitBytes > 0);
  for (let n = 0; result.status === "running" && n < 20; n++)
    result = await s.service.advance(s.owner.token, "firmament", {
      repo: s.owner.repo,
      id: "scenario",
      expectedHead: result.commit.id,
    });
  assert.equal(result.status, "completed");
  assert.equal(s.calls.length, 11);
  assert.match(result.report!, /Qualitative/);
  assert.equal(result.calibrated, false);
  assert.equal(
    s.service.load(s.owner.token, "firmament", s.owner.repo, "scenario").status,
    "completed",
  );
});
test("explicit aggregate processing consent and paid plan are independent of successful CID sign-in", async () => {
  const s = await fixture();
  assert.throws(() =>
    s.service.create(
      s.owner.token,
      "firm",
      input(s.owner.repo, { consent: false }),
    ),
  );
  s.setPaid(false);
  assert.throws(() =>
    s.service.create(s.owner.token, "firm", input(s.owner.repo)),
  );
  assert.equal(s.calls.length, 0);
});
test("tenant/product isolation, expected-head CAS and server-side ID ownership prevent arbitrary jobs", async () => {
  const s = await fixture(),
    other = await s.login();
  assert.throws(() =>
    s.service.create(other.token, "firm", input(s.owner.repo)),
  );
  const created = s.service.create(s.owner.token, "firm", input(s.owner.repo));
  assert.throws(() =>
    s.service.create(s.owner.token, "firm", input(s.owner.repo)),
  );
  assert.throws(() =>
    s.service.load(s.owner.token, "veil", s.owner.repo, "scenario"),
  );
  await assert.rejects(() =>
    s.service.advance(s.owner.token, "firm", {
      repo: s.owner.repo,
      id: "../x",
      expectedHead: created.commit.id,
    }),
  );
  assert.equal(s.calls.length, 0);
});
test("signed state rejects writer-forged upstream project IDs before any request", async () => {
  const s = await fixture(),
    created = s.service.create(s.owner.token, "firm", input(s.owner.repo)),
    client = s.auth.forProduct(s.owner.token, "firm"),
    raw = JSON.parse(
      Buffer.from(
        client.load(
          s.owner.repo,
          created.commit.id,
          "conjure/jobs/scenario.json",
        ),
      ).toString(),
    );
  raw.payload.job.ids.project_id = "other-client-project";
  const edited = client.save(
    s.owner.repo,
    "conjure/jobs/scenario.json",
    JSON.stringify(raw),
    created.commit.id,
  );
  await assert.rejects(() =>
    s.service.advance(s.owner.token, "firm", {
      repo: s.owner.repo,
      id: "scenario",
      expectedHead: edited.id,
    }),
  );
  assert.equal(s.calls.length, 0);
});
test("revoked write consent prevents external effects before execution", async () => {
  const s = await fixture(),
    created = s.service.create(s.owner.token, "firm", input(s.owner.repo));
  await s.cid.revoke(s.owner.account.cid, "LBRNTH", ["repo:write"]);
  await assert.rejects(() =>
    s.service.advance(s.owner.token, "firm", {
      repo: s.owner.repo,
      id: "scenario",
      expectedHead: created.commit.id,
    }),
  );
  assert.equal(s.calls.length, 0);
});
test("revocation during an awaited engine request denies its result and leaves a non-replayable claim", async () => {
  const s = await setup();
  const f = fakeEngine(async () => {
    await s.cid.revokeSession(s.owner.account.cid, s.owner.session.id);
    return Response.json({ success: true, data: { project_id: "p1" } });
  });
  const service = new ConjureService(s.auth, {
      engine: f.client,
      entitled: () => true,
      integrityKey: Buffer.alloc(32, 1),
    }),
    created = service.create(s.owner.token, "firm", input(s.owner.repo));
  await assert.rejects(() =>
    service.advance(s.owner.token, "firm", {
      repo: s.owner.repo,
      id: "scenario",
      expectedHead: created.commit.id,
    }),
  );
  assert.equal(f.calls.length, 1);
});
test("concurrent step replay cannot repeat a kickoff, including through a second service instance", async () => {
  const s = await setup();
  let release!: (r: Response) => void;
  const f = fakeEngine(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    ),
    options = {
      engine: f.client,
      entitled: () => true,
      integrityKey: Buffer.alloc(32, 1),
    },
    a = new ConjureService(s.auth, options),
    b = new ConjureService(s.auth, options);
  const created = a.create(s.owner.token, "firm", input(s.owner.repo)),
    first = a.advance(s.owner.token, "firm", {
      repo: s.owner.repo,
      id: "scenario",
      expectedHead: created.commit.id,
    });
  await new Promise((resolve) => setImmediate(resolve));
  const claim = s.auth
    .forProduct(s.owner.token, "firm")
    .history(s.owner.repo, "main", 1)[0]!;
  await assert.rejects(() =>
    b.advance(s.owner.token, "firm", {
      repo: s.owner.repo,
      id: "scenario",
      expectedHead: claim.id,
    }),
  );
  release(Response.json({ success: true, data: { project_id: "p1" } }));
  await first;
  assert.equal(f.calls.length, 1);
});
test("cyber/exercise checkpoints record bounded numeric results without names, payloads or target fields", async () => {
  const s = await fixture(),
    recorded = s.service.record(s.owner.token, "odin", {
      repo: s.owner.repo,
      id: "http",
      expectedHead: null,
      kind: "cyber",
      metrics: { requests: 10, failures: 2, denied: 1 },
    });
  const created = s.service.create(
    s.owner.token,
    "odin",
    input(s.owner.repo, {
      expectedHead: recorded.id,
      source: {
        kind: "cyber",
        commit: recorded.id,
        paths: ["signals/cyber/http.json"],
      },
    }),
  );
  assert.equal(created.evidence.metrics.failures, 2);
  assert.throws(() =>
    s.service.record(s.owner.token, "odin", {
      repo: s.owner.repo,
      id: "bad",
      expectedHead: created.commit.id,
      kind: "cyber",
      metrics: { requests: 1, failures: 0, denied: 0, person: "x" },
    }),
  );
});

test("paid Labyrinth/CID access does not grant the independent CONJURE entitlement", async () => {
  const s = await setup(),
    f = fakeEngine(),
    service = new ConjureService(s.auth, {
      engine: f.client,
      integrityKey: Buffer.alloc(32, 9),
    });
  assert.throws(
    () => service.create(s.owner.token, "firm", input(s.owner.repo)),
    /Independent CONJURE plan/,
  );
  assert.equal(f.calls.length, 0);
});

for (const preset of CONJURE_PRODUCT_PRESETS)
  test(`${preset.product}: real quota evidence reaches the CONJURE ontology contract without data-sale permission`, async () => {
    const s = await fixture(),
      created = s.service.create(
        s.owner.token,
        preset.product,
        input(s.owner.repo),
      );
    const advanced = await s.service.advance(s.owner.token, preset.product, {
      repo: s.owner.repo,
      id: "scenario",
      expectedHead: created.commit.id,
    });
    assert.equal(advanced.step, "graph_build");
    assert.equal(advanced.dataSaleAllowed, false);
    assert.equal(s.calls.length, 1);
    const form = s.calls[0]!.init.body as FormData,
      seed = await (form.get("files") as Blob).text();
    assert.match(seed, /orgLimitBytes/);
    assert.ok(!seed.includes(s.owner.token));
    assert.ok(!seed.includes(s.owner.account.cid));
  });
for (const product of ["cloud", "aether", "fabric", "hrvst", "metatron"])
  test(`${product}: actual archive outbox receipts feed delivery scenarios, not their private payload`, async () => {
    const s = await fixture(),
      ingest = new ArchiveIngest(s.auth),
      receipt = ingest.submit(s.owner.token, product, "source", s.owner.repo, {
        id: "event",
        kind: "archive",
        payload: { private: "must-not-leave" },
      }),
      created = s.service.create(
        s.owner.token,
        product,
        input(s.owner.repo, {
          expectedHead: receipt.commitId,
          source: {
            kind: "delivery",
            commit: receipt.commitId,
            paths: ["ingest/source/event.json"],
          },
        }),
      );
    assert.equal(created.evidence.metrics.pending, 1);
    await s.service.advance(s.owner.token, product, {
      repo: s.owner.repo,
      id: "scenario",
      expectedHead: created.commit.id,
    });
    const form = s.calls[0]!.init.body as FormData;
    assert.ok(
      !(await (form.get("files") as Blob).text()).includes("must-not-leave"),
    );
  });
for (const product of ["daemon", "slug", "orbis", "pollen", "flower"])
  test(`${product}: selected historical battery diagnostics reach CONJURE without trajectory fields`, async () => {
    const s = await fixture(),
      c = s.auth.forProduct(s.owner.token, product).save(
        s.owner.repo,
        "logs/unit/log.json",
        JSON.stringify({
          product,
          vehicle: "private-unit",
          observations: [
            { kind: "globalPosition", data: { latDeg: 40, lonDeg: 30 } },
            { kind: "systemStatus", data: { batteryPct: 75 } },
          ],
        }),
        null,
      ),
      created = s.service.create(
        s.owner.token,
        product,
        input(s.owner.repo, {
          expectedHead: c.id,
          source: {
            kind: "telemetry",
            commit: c.id,
            paths: ["logs/unit/log.json"],
          },
        }),
      );
    assert.equal(created.evidence.metrics.meanBatteryPct, 75);
    await s.service.advance(s.owner.token, product, {
      repo: s.owner.repo,
      id: "scenario",
      expectedHead: created.commit.id,
    });
    const text = await (
      (s.calls[0]!.init.body as FormData).get("files") as Blob
    ).text();
    assert.ok(!text.includes("latDeg") && !text.includes("private-unit"));
  });
test("EON exercise checkpoints become scenario inputs, not mission/target predictions", async () => {
  const s = await fixture(),
    c = s.service.record(s.owner.token, "eon", {
      repo: s.owner.repo,
      id: "checks",
      expectedHead: null,
      kind: "exercise",
      metrics: { trials: 5, failedTrials: 1 },
    }),
    created = s.service.create(
      s.owner.token,
      "eon",
      input(s.owner.repo, {
        expectedHead: c.id,
        source: {
          kind: "exercise",
          commit: c.id,
          paths: ["signals/exercise/checks.json"],
        },
      }),
    );
  assert.equal(created.evidence.metrics.failedTrials, 1);
});
test("inference-plan revocation while awaiting CONJURE denies the result independently of CID and storage", async () => {
  const s = await setup();
  let paid = true;
  const f = fakeEngine(() => {
      paid = false;
      return Response.json({ success: true, data: { project_id: "p1" } });
    }),
    service = new ConjureService(s.auth, {
      engine: f.client,
      entitled: () => paid,
      integrityKey: Buffer.alloc(32, 2),
    }),
    created = service.create(s.owner.token, "firm", input(s.owner.repo));
  await assert.rejects(
    () =>
      service.advance(s.owner.token, "firm", {
        repo: s.owner.repo,
        id: "scenario",
        expectedHead: created.commit.id,
      }),
    /Independent CONJURE/,
  );
  assert.ok(s.cid.authenticate(s.owner.token));
});
test("step deadline fails closed without replaying an uncertain upstream effect", async () => {
  const s = await setup();
  let release!: (r: Response) => void;
  const f = fakeEngine(
      () =>
        new Promise<Response>((r) => {
          release = r;
        }),
    ),
    service = new ConjureService(s.auth, {
      engine: f.client,
      entitled: () => true,
      integrityKey: Buffer.alloc(32, 2),
      stepTimeoutMs: 10,
    }),
    created = service.create(s.owner.token, "firm", input(s.owner.repo));
  await assert.rejects(
    () =>
      service.advance(s.owner.token, "firm", {
        repo: s.owner.repo,
        id: "scenario",
        expectedHead: created.commit.id,
      }),
    /deadline/,
  );
  const state = service.load(s.owner.token, "firm", s.owner.repo, "scenario");
  assert.equal(state.phase, "inflight");
  await assert.rejects(() =>
    service.advance(s.owner.token, "firm", {
      repo: s.owner.repo,
      id: "scenario",
      expectedHead: state.commit.id,
    }),
  );
  release(Response.json({ success: true, data: { project_id: "late" } }));
  assert.equal(f.calls.length, 1);
});

for (const product of ["firmament", "orbis"])
  test(`${product}: actual orbital backend link-budget archives feed only numeric scenario summaries`, async () => {
    const s = await fixture(),
      handler = orbitalBackend(s.auth),
      response = await handler(
        new Request(`https://backend.example/api/orbital/${product}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${s.owner.token}`,
          },
          body: JSON.stringify({
            action: "link-budget",
            repo: s.owner.repo,
            id: "budget",
            expectedHead: null,
            parameters: {
              distanceKm: 1000,
              frequencyHz: 1e9,
              txPowerDbm: 30,
              txGainDbi: 20,
              rxGainDbi: 20,
              bandwidthHz: 1e6,
              requiredSnrDb: 10,
            },
          }),
        }),
      );
    assert.equal(response.status, 200);
    const saved = await response.json(),
      created = s.service.create(
        s.owner.token,
        product,
        input(s.owner.repo, {
          expectedHead: saved.commit.id,
          source: {
            kind: "orbital",
            commit: saved.commit.id,
            paths: ["orbital/budgets/budget.json"],
          },
        }),
      );
    assert.equal(
      created.evidence.metrics.minimumIllustrativeMarginDb,
      saved.artifact.data.marginDb,
    );
    await s.service.advance(s.owner.token, product, {
      repo: s.owner.repo,
      id: "scenario",
      expectedHead: created.commit.id,
    });
    const seed = await (
      (s.calls[0]!.init.body as FormData).get("files") as Blob
    ).text();
    assert.ok(!seed.includes("frequencyHz") && !seed.includes("distanceKm"));
  });
test("scenario lifetime is enforced before external effects", async () => {
  const s = await setup(),
    f = fakeEngine();
  let now = Date.now();
  const service = new ConjureService(s.auth, {
      engine: f.client,
      entitled: () => true,
      integrityKey: Buffer.alloc(32, 2),
      clock: () => new Date(now),
    }),
    created = service.create(s.owner.token, "firm", input(s.owner.repo));
  now += 86400001;
  await assert.rejects(
    () =>
      service.advance(s.owner.token, "firm", {
        repo: s.owner.repo,
        id: "scenario",
        expectedHead: created.commit.id,
      }),
    /lifetime/,
  );
  assert.equal(f.calls.length, 0);
});
test("stop before simulation creation persists a stopped job without any engine request", async () => {
  const s = await fixture(),
    created = s.service.create(s.owner.token, "firm", input(s.owner.repo)),
    stopped = await s.service.advance(
      s.owner.token,
      "firm",
      { repo: s.owner.repo, id: "scenario", expectedHead: created.commit.id },
      true,
    );
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.phase, "idle");
  assert.equal(s.calls.length, 0);
});
