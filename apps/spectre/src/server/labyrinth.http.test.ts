import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harness } from "./test-harness.ts";
import { CidLabyrinth, MemoryStorage, labyrinthFromEnvironment } from "@infinitum/lbrnth";

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

test("Spectre deployment config stores an encrypted snapshot a restarted service can read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lbrnth-spectre-release-"));
  const path = join(dir, "private", "labyrinth.json");
  const env = { LBRNTH_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"), LBRNTH_ENTITLED_ORGS: "" };
  const h = await harness({ labyrinth: labyrinthFromEnvironment(env, path) });
  try {
    const identity = await h.signUp("release-client");
    await h.suite.cid.createOrganization("Release", identity.cid);
    const org = h.suite.cid.organizationMembership(identity.cid);
    assert.ok(org);
    env.LBRNTH_ENTITLED_ORGS = org.id;
    const command = (body: unknown) => h.call("POST", "/api/labyrinth", body, identity.cookie, { "x-labyrinth": "1" });
    assert.equal((await command({ action: "consent", product: "spectre", scopes: ["repo:read", "repo:write", "repo:admin"] })).status, 200);
    assert.equal((await command({ action: "provision", product: "spectre" })).status, 200);
    const created = await command({ action: "create", product: "spectre", name: "release" });
    assert.equal(created.status, 200);
    const saved = await command({ action: "save", product: "spectre", repo: created.body.id, path: "deal.json", content: "snapshot-secret", expectedHead: null });
    assert.equal(saved.status, 200);
    const raw = readFileSync(path, "utf8");
    // Windows has no POSIX permission bits (it reports 0o666), so check them only elsewhere.
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(raw.includes("snapshot-secret"), false);
    assert.equal(raw.includes(env.LBRNTH_MASTER_KEY), false);
    const token = identity.cookie.slice("spctr_session=".length);
    const restarted = new CidLabyrinth(h.suite.cid, labyrinthFromEnvironment(env, path)!);
    assert.equal(Buffer.from(restarted.forProduct(token, "spectre").load(created.body.id, saved.body.id, "deal.json")).toString(), "snapshot-secret");
    const afterRestore = readFileSync(path, "utf8");
    env.LBRNTH_ENTITLED_ORGS = "";
    assert.equal((await command({ action: "list", product: "spectre" })).status, 403);
    assert.equal(readFileSync(path, "utf8"), afterRestore);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
