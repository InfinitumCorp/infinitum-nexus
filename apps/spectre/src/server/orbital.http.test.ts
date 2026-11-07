import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@infinitum/lbrnth";
import { harness } from "./test-harness.ts";
import { omm } from "../../../../packages/orbital/src/fixtures.ts";
test("CID host exposes offline orbital artifacts through explicit bearer, with live plan checks and product isolation", async () => {
  let paid = true;
  const h = await harness({
    labyrinth: { storage: new MemoryStorage(), entitled: () => paid },
  });
  try {
    const owner = await h.signUp("orbital-http");
    await h.suite.cid.createOrganization("Offline planning client", owner.cid);
    const lab = (body: unknown) =>
      h.call("POST", "/api/labyrinth", body, owner.cookie, {
        "x-labyrinth": "1",
      });
    assert.equal(
      (
        await lab({
          action: "consent",
          product: "firmament",
          scopes: ["repo:read", "repo:write", "repo:admin"],
        })
      ).status,
      200,
    );
    assert.equal(
      (await lab({ action: "provision", product: "firmament" })).status,
      200,
    );
    const repo = await lab({
        action: "create",
        product: "firmament",
        name: "orbital-fixtures",
      }),
      delegated = await lab({ action: "token", product: "firmament" }),
      headers = { authorization: `Bearer ${delegated.body.token}` };
    const data = {
      action: "omm",
      repo: repo.body.id,
      id: "fixture",
      expectedHead: null,
      elements: omm,
    };
    assert.equal(
      (await h.call("POST", "/api/orbital/firmament", data, owner.cookie))
        .status,
      401,
    );
    const saved = await h.call(
      "POST",
      "/api/orbital/firmament",
      data,
      undefined,
      headers,
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.artifact.simulationOnly, true);
    const load = {
      action: "load",
      repo: repo.body.id,
      commit: saved.body.commit.id,
      path: saved.body.path,
    };
    assert.equal(
      (await h.call("POST", "/api/orbital/orbis", load, undefined, headers))
        .status,
      404,
    );
    assert.equal(
      (
        await h.call("POST", "/api/orbital/firmament", load, undefined, {
          ...headers,
          host: "attacker.example",
          origin: "https://attacker.example",
          "x-forwarded-host": "attacker.example",
        })
      ).status,
      403,
    );
    paid = false;
    assert.equal(
      (await h.call("POST", "/api/orbital/firmament", load, undefined, headers))
        .status,
      403,
    );
  } finally {
    await h.close();
  }
});
test("orbital host fails closed without an operator-configured CID/Labyrinth backend", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call("POST", "/api/orbital/orbis", {})).status, 503);
  } finally {
    await h.close();
  }
});
