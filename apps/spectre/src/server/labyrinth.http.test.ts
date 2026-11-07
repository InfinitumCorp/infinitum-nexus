import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./test-harness.ts";
import { MemoryStorage } from "@infinitum/lbrnth";

test("Spectre mounts Labyrinth on real CID login cookies, with plan and live consent gating", async () => {
  let paid = true;
  const h = await harness({ labyrinth: { entitled: () => paid, storage: new MemoryStorage() } });
  try {
    const identity = await h.signUp("repo-client");
    await h.suite.cid.createOrganization("Client", identity.cid);

    const command = (body: unknown, cookie = identity.cookie) => h.call("POST", "/api/labyrinth", body, cookie, { "x-labyrinth": "1" });
    assert.equal((await command({ action: "list", product: "spectre" }, "")).status, 401);
    assert.equal((await command({ action: "consent", product: "spectre", scopes: ["repo:read", "repo:write", "repo:admin"] })).status, 200);
    assert.equal((await command({ action: "provision", product: "spectre" })).status, 200);
    const created = await command({ action: "create", product: "spectre", name: "client-code" }); assert.equal(created.status, 200);
    const saved = await command({ action: "save", product: "spectre", repo: created.body.id, path: "deal.json", content: "private", expectedHead: null }); assert.equal(saved.status, 200);
    const read = await command({ action: "load", product: "spectre", repo: created.body.id, commit: saved.body.id, path: "deal.json" }); assert.equal(read.body.content, "private");
    const issued = await command({ action: "token", product: "spectre" }); assert.equal(issued.status, 200);
    assert.match(issued.body.token, /^lbrnth_/);
    const remote = await h.call("POST", "/api/labyrinth", { action: "list", product: "odin" }, undefined, { "x-labyrinth": "1", authorization: `Bearer ${issued.body.token}` });
    assert.equal(remote.status, 200);
    paid = false; assert.equal((await command({ action: "list", product: "spectre" })).status, 403); paid = true;
    await h.suite.cid.revoke(identity.cid, "LBRNTH"); assert.equal((await command({ action: "list", product: "spectre" })).status, 403);
    assert.equal((await h.call("POST", "/api/labyrinth", { action: "list", product: "spectre" }, identity.cookie)).status, 403);
  } finally { await h.close(); }
});

test("Labyrinth is explicitly unavailable without configured billing/storage", async () => {
  const h = await harness();
  try { assert.equal((await h.call("POST", "/api/labyrinth", { action: "list", product: "spectre" })).status, 503); }
  finally { await h.close(); }
});
