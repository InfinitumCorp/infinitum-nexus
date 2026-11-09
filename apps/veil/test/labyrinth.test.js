import { test } from "node:test";
import assert from "node:assert/strict";
import { veilLabyrinth } from "../lib/labyrinth.js";
test("anonymous VEIL never calls Labyrinth or sends identifying cookies", async () => {
  await assert.rejects(veilLabyrinth("https://cid.example", "anonymous", { action: "list" }, () => { throw new Error("Must not fetch"); }), /sign-in/);
});
test("signed-in VEIL uses CID cookie authority and a fixed veil artifact namespace", async () => {
  const result = await veilLabyrinth("https://cid.example", "authenticated", { action: "list", product: "spoof" }, async (url, options) => {
    assert.equal(url, "https://cid.example/api/labyrinth"); assert.equal(options.credentials, "include"); assert.equal(options.redirect, "error");
    assert.equal(JSON.parse(options.body).product, "veil"); return Response.json([]);
  }); assert.deepEqual(result, []);
});
