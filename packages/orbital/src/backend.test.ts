import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { orbitalBackend } from "./backend.ts";
import { setup } from "./testing.ts";
import { omm, tle } from "./fixtures.ts";
const url = "https://planner.example/api/orbital/firmament";
const body = (
  repo: string,
  action: string,
  rest: Record<string, unknown> = {},
) => ({ repo, action, ...rest });
async function fixture() {
  const s = await setup(),
    handler = orbitalBackend(s.auth);
  const call = (
    data: unknown,
    token = s.owner.token,
    product = "firmament",
    headers: Record<string, string> = {},
  ) =>
    handler(
      new Request(`https://planner.example/api/orbital/${product}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...headers,
        },
        body: JSON.stringify(data),
      }),
    );
  return { ...s, handler, call };
}
test("real CID session writes OMM, propagates from immutable source, predicts and loads private artifacts", async () => {
  const s = await fixture(),
    repo = s.owner.repo;
  const initial = await s.call(
    body(repo, "omm", { id: "example", expectedHead: null, elements: omm }),
  );
  assert.equal(initial.status, 200);
  const saved = await initial.json();
  assert.match(saved.commit.id, /^[a-f0-9]{64}$/);
  assert.equal(saved.commit.tree, undefined);
  assert.equal(saved.artifact.product, "firmament");
  assert.equal(saved.artifact.data.epoch, "2026-11-07T00:00:00.123Z");
  const source = { id: "example", commit: saved.commit.id };
  const result = await s.call(
    body(repo, "propagate", {
      id: "state",
      expectedHead: saved.commit.id,
      source,
      at: "2026-11-07T01:00:00Z",
    }),
  );
  assert.equal(result.status, 200);
  const state = await result.json();
  assert.equal(state.artifact.data.frame, "TEME");
  assert.deepEqual(state.artifact.source, source);
  const pass = await s.call(
    body(repo, "passes", {
      id: "passes",
      expectedHead: state.commit.id,
      source,
      options: {
        station: {
          id: "s1",
          latitudeDeg: 0,
          longitudeDeg: 0,
          heightM: 0,
          minElevationDeg: 10,
        },
        start: "2026-11-07T00:00:00Z",
        end: "2026-11-08T00:00:00Z",
        stepSeconds: 60,
      },
    }),
  );
  assert.equal(pass.status, 200);
  const predicted = await pass.json();
  assert.ok(predicted.artifact.data.passes.length > 0);
  const loaded = await s.call(
    body(repo, "load", { commit: predicted.commit.id, path: predicted.path }),
  );
  assert.deepEqual(await loaded.json(), predicted.artifact);
  assert.equal(
    (
      await s.call(
        body(repo, "propagate", {
          id: "bad",
          expectedHead: predicted.commit.id,
          source,
          at: "2027-01-01T00:00:00Z",
        }),
      )
    ).status,
    400,
  );
});
test("ORBIS TLE ingest, schedules and budgets persist with expected-head conflict protection", async () => {
  const s = await fixture(),
    repo = s.owner.repo;
  let result = await s.call(
    body(repo, "tle", {
      id: "test",
      expectedHead: null,
      line1: tle.line1,
      line2: tle.line2,
    }),
    s.owner.token,
    "orbis",
  );
  assert.equal(result.status, 200);
  let saved = await result.json();
  result = await s.call(
    body(repo, "schedule", {
      id: "contacts",
      expectedHead: saved.commit.id,
      requests: [],
      options: { turnaroundSeconds: 30 },
    }),
    s.owner.token,
    "orbis",
  );
  assert.equal(result.status, 200);
  saved = await result.json();
  assert.equal(saved.artifact.data.externalReservation, false);
  result = await s.call(
    body(repo, "link-budget", {
      id: "budget",
      expectedHead: saved.commit.id,
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
    s.owner.token,
    "orbis",
  );
  assert.equal(result.status, 200);
  assert.equal(
    (
      await s.call(
        body(repo, "omm", { id: "clobber", expectedHead: null, elements: omm }),
      )
    ).status,
    409,
  );
});
test("catalog hashes an existing private artifact, records source commit, and cannot cross product boundaries", async () => {
  const s = await fixture(),
    repo = s.owner.repo,
    bytes = Buffer.from("private test imagery");
  const source = s.auth
    .forProduct(s.owner.token, "firmament")
    .save(repo, "imagery/test.tif", bytes, null);
  const response = await s.call(
    body(repo, "catalog", {
      id: "image",
      expectedHead: source.id,
      source: { commit: source.id, path: "imagery/test.tif" },
      observedAt: "2026-11-07T00:00:00Z",
      mediaType: "image/tiff",
    }),
  );
  assert.equal(response.status, 200);
  const saved = await response.json(),
    item = saved.artifact.data;
  assert.equal(item.type, "Feature");
  assert.equal(item.geometry, null);
  assert.equal(
    item.assets.source["infinitum:sha256"],
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(item.assets.source["infinitum:bytes"], bytes.length);
  assert.ok(
    item.assets.source.href.includes(`/products/firmament/imagery/test.tif`),
  );
  const cross = await s.call(
    body(repo, "catalog", {
      id: "bad",
      expectedHead: saved.commit.id,
      source: { commit: source.id, path: "imagery/test.tif" },
      observedAt: "2026-11-07T00:00:00Z",
      mediaType: "image/tiff",
    }),
    s.owner.token,
    "orbis",
  );
  assert.equal(cross.status, 404);
  assert.equal(
    (
      await s.call(
        body(repo, "load", {
          commit: saved.commit.id,
          path: "../orbis/private.json",
        }),
      )
    ).status,
    400,
  );
});
test("no anonymous/cookie-only access; real credentials do not imply entitlement, consent or cross-tenant authority", async () => {
  const s = await fixture(),
    data = body(s.owner.repo, "omm", {
      id: "x",
      expectedHead: null,
      elements: omm,
    });
  assert.equal(
    (
      await s.handler(
        new Request(url, {
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
  assert.equal((await s.call(data, "forged-cid-id")).status, 403);
  const other = await s.login();
  assert.equal((await s.call(data, other.token)).status, 404);
  s.setPaid(false);
  assert.equal((await s.call(data)).status, 403);
  s.setPaid(true);
  await s.cid.revoke(s.owner.account.cid, "LBRNTH");
  assert.equal((await s.call(data)).status, 403);
});
test("parent-session revocation and expiration invalidate delegated bearer on the next request", async () => {
  const s = await fixture(),
    token = s.auth.issueToken(s.owner.token).token,
    data = body(s.owner.repo, "omm", {
      id: "x",
      expectedHead: null,
      elements: omm,
    });
  assert.equal((await s.call(data, token)).status, 200);
  await s.cid.revokeSession(s.owner.account.cid, s.owner.session.id);
  assert.equal((await s.call(data, token)).status, 403);
  const other = await s.login();
  s.expire();
  assert.equal(
    (
      await s.call(
        body(other.repo, "omm", { id: "x", expectedHead: null, elements: omm }),
        other.token,
      )
    ).status,
    403,
  );
});
test("bounded HTTP adapter refuses origins, content encodings, excessive input and unknown fields without reflecting data", async () => {
  const s = await fixture(),
    data = body(s.owner.repo, "omm", {
      id: "x",
      expectedHead: null,
      elements: omm,
    });
  assert.equal(
    (
      await s.call(data, s.owner.token, "firmament", {
        origin: "https://attacker.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await s.call(data, s.owner.token, "firmament", {
        "content-encoding": "gzip",
      })
    ).status,
    415,
  );
  assert.equal(
    (await s.call({ ...data, unknown: "must-not-echo" })).status,
    400,
  );
  const denied = await s.call({ ...data, id: "../must-not-echo" });
  assert.equal(denied.status, 400);
  assert.ok(!(await denied.text()).includes("must-not-echo"));
  assert.equal(denied.headers.get("cache-control"), "no-store");
  assert.equal((await s.call({ x: "a".repeat(65537) })).status, 413);
  assert.equal((await s.call(data, s.owner.token, "throne")).status, 404);
  assert.equal((await s.handler(new Request(url))).status, 405);
});

test("delegated credential expires independently of its active parent CID session", async () => {
  const s = await fixture(),
    token = s.auth.issueToken(s.owner.token).token;
  s.advance(16 * 60000);
  assert.ok(s.cid.authenticate(s.owner.token));
  assert.equal(
    (
      await s.call(
        body(s.owner.repo, "omm", {
          id: "x",
          expectedHead: null,
          elements: omm,
        }),
        token,
      )
    ).status,
    403,
  );
});
test("read-only consent can retrieve but cannot commit new planning artifacts", async () => {
  const s = await fixture(),
    repo = s.owner.repo;
  const saved = await (
    await s.call(
      body(repo, "omm", { id: "x", expectedHead: null, elements: omm }),
    )
  ).json();
  await s.cid.revoke(s.owner.account.cid, "LBRNTH", ["repo:write"]);
  assert.equal(
    (
      await s.call(
        body(repo, "load", { commit: saved.commit.id, path: saved.path }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await s.call(
        body(repo, "omm", {
          id: "denied",
          expectedHead: saved.commit.id,
          elements: omm,
        }),
      )
    ).status,
    403,
  );
});
test("body decoding and declared/streamed size limits fail closed", async () => {
  const s = await fixture(),
    headers = {
      "content-type": "application/json",
      authorization: `Bearer ${s.owner.token}`,
    };
  for (const payload of ["{invalid-json", "[]"]) {
    assert.equal(
      (
        await s.handler(
          new Request(url, { method: "POST", headers, body: payload }),
        )
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await s.handler(
        new Request(url, {
          method: "POST",
          headers: { ...headers, "content-length": "65537" },
          body: "{}",
        }),
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await s.handler(
        new Request(url, {
          method: "POST",
          headers,
          body: new Uint8Array([0xff]),
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await s.handler(
        new Request(url + "?unexpected=1", {
          method: "POST",
          headers,
          body: "{}",
        }),
      )
    ).status,
    404,
  );
});
