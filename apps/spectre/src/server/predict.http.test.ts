import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@infinitum/lbrnth";
import { ConjureService } from "../../../../packages/conjure-backend/src/service.ts";
import { fakeEngine } from "../../../../packages/conjure/src/engine-testing.ts";
import { harness } from "./test-harness.ts";
test("real CID host mounts CONJURE aggregate forecasts with explicit bearers and live plan checks", async () => {
  let paid = true;
  const f = fakeEngine(),
    h = await harness({
      labyrinth: { storage: new MemoryStorage(), entitled: () => paid },
      conjure: (auth) =>
        new ConjureService(auth, {
          engine: f.client,
          entitled: () => true,
          integrityKey: Buffer.alloc(32, 1),
        }),
    });
  try {
    const owner = await h.signUp("conjure-http");
    await h.suite.cid.createOrganization("Private scenario client", owner.cid);
    const lab = (body: unknown) =>
      h.call("POST", "/api/labyrinth", body, owner.cookie, {
        "x-labyrinth": "1",
      });
    await lab({
      action: "consent",
      product: "firm",
      scopes: ["repo:read", "repo:write", "repo:admin"],
    });
    await lab({ action: "provision", product: "firm" });
    const repo = await lab({
        action: "create",
        product: "firm",
        name: "scenarios",
      }),
      token = await lab({ action: "token", product: "firm" }),
      headers = { authorization: `Bearer ${token.body.token}` },
      data = {
        action: "create",
        repo: repo.body.id,
        id: "scenario",
        source: { kind: "storage" },
        expectedHead: null,
        consent: true,
      };
    assert.equal(
      (await h.call("POST", "/api/predict/firm", data, owner.cookie)).status,
      401,
    );
    const created = await h.call(
      "POST",
      "/api/predict/firm",
      data,
      undefined,
      headers,
    );
    assert.equal(created.status, 200);
    assert.equal(created.body.dataSaleAllowed, false);
    const advanced = await h.call(
      "POST",
      "/api/predict/firm",
      {
        action: "advance",
        repo: repo.body.id,
        id: "scenario",
        expectedHead: created.body.commit.id,
      },
      undefined,
      headers,
    );
    assert.equal(advanced.status, 200);
    assert.equal(advanced.body.step, "graph_build");
    assert.equal(f.calls.length, 1);
    assert.equal(
      (
        await h.call("POST", "/api/predict/firm", {}, undefined, {
          ...headers,
          host: "evil.example",
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    paid = false;
    assert.equal(
      (
        await h.call(
          "POST",
          "/api/predict/firm",
          { action: "load", repo: repo.body.id, id: "scenario" },
          undefined,
          headers,
        )
      ).status,
      403,
    );
  } finally {
    await h.close();
  }
});
test("unconfigured CONJURE fails closed without demo reports or provider calls", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call("POST", "/api/predict/firm", {})).status, 503);
  } finally {
    await h.close();
  }
});
