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
    const org = await h.suite.cid.organizationMembership(identity.cid);
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
    const restarted = new CidLabyrinth(h.suite.cid.syncView(), labyrinthFromEnvironment(env, path)!);
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

test("repository workspace completes branch, tag, delete, member and audit flows through CID HTTP", async () => {
  const h = await harness({ labyrinth: { entitled: () => true, storage: new MemoryStorage() } });
  try {
    const owner = await h.signUp("workspace-owner");
    const org = await h.suite.cid.createOrganization("Workspace", owner.cid);
    const call = (action: string, args: Record<string, unknown> = {}, cookie = owner.cookie) => h.call("POST", "/api/labyrinth", { product: "spectre", action, ...args }, cookie, { "x-labyrinth": "1" });
    const session = await call("session");
    assert.equal(session.body.organization.id, org.id);
    assert.deepEqual(session.body.scopes, []);
    await call("consent", { scopes: ["repo:read", "repo:write", "repo:admin"] });
    await call("provision");
    const repo = (await call("create", { name: "workspace" })).body;
    const first = (await call("save", { repo: repo.id, path: "src/main.ts", content: "first", expectedHead: null })).body;
    assert.equal((await call("branch", { repo: repo.id, name: "feature", from: first.id })).status, 200);
    const changed = await call("save", { repo: repo.id, path: "src/main.ts", branch: "feature", content: "second", expectedHead: first.id });
    assert.equal(changed.status, 200);
    assert.equal((await call("tag", { repo: repo.id, name: "v1", commit: first.id })).status, 200);
    assert.equal((await call("tag", { repo: repo.id, name: "v1", commit: changed.body.id })).status, 409);
    assert.equal((await call("save", { repo: repo.id, branch: "feature", path: "src/main.ts", content: "stale", expectedHead: first.id })).status, 409);
    const removed = await call("remove", { repo: repo.id, path: "src/main.ts", branch: "feature", expectedHead: changed.body.id });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.tree, {});
    assert.equal((await call("load", { repo: repo.id, path: "src/main.ts", commit: first.id })).body.content, "first");
    assert.equal((await call("load", { repo: repo.id, path: "src/main.ts", commit: removed.body.id })).status, 404);
    assert.equal((await call("diff", { repo: repo.id, from: changed.body.id, to: removed.body.id })).body[0].kind, "deleted");
    const target = await h.suite.cid.createAccount({ username: "workspace-reader", orgId: org.id });
    assert.equal((await call("set-member", { member: target.cid, memberRole: "reader" })).status, 200);
    assert.ok((await call("members")).body.some((m: { cid: string; role: string }) => m.cid === target.cid && m.role === "reader"));
    assert.equal((await call("set-member", { member: target.cid, memberRole: "root" })).status, 400);
    assert.equal((await call("set-member", { member: owner.cid, memberRole: null })).status, 409);
    const outsider = await h.suite.cid.createAccount({ username: "outsider" });
    await h.suite.cid.createOrganization("Other", outsider.cid);
    assert.equal((await call("set-member", { member: outsider.cid, memberRole: "reader" })).status, 403);
    const audit = await call("audit"); assert.equal(audit.status, 200);
    assert.ok(audit.body.some((e: { action: string }) => e.action.startsWith("branch.create")));
    assert.equal(JSON.stringify(audit.body).includes('"content"'), false);
    assert.equal((await call("set-member", { member: target.cid, memberRole: null })).status, 200);
    assert.equal((await call("list", { org: "forged" })).status, 400);
    const invalidBearer = await h.call("POST", "/api/labyrinth", { product: "spectre", action: "list" }, owner.cookie, { "x-labyrinth": "1", authorization: "Basic invalid" });
    assert.equal(invalidBearer.status, 401);
  } finally { await h.close(); }
});

test("shared repository UI serves hardened assets and no private data without a session", async () => {
  const h = await harness();
  try {
    for (const path of ["/labyrinth", "/labyrinth/", "/labyrinth/assets/style.css", "/labyrinth/assets/app.js"]) {
      const response = await fetch(h.base + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
      assert.match(response.headers.get("content-security-policy")!, /script-src 'self'/);
    }
    assert.equal((await fetch(h.base + "/labyrinth/assets/not-found.js")).status, 404);
    assert.equal((await fetch(h.base + "/labyrinth", { method: "POST" })).status, 405);
    assert.equal((await fetch(h.base + "/labyrinth", { method: "HEAD" })).status, 200);
    assert.equal((await fetch(h.base + "/labyrinth", { method: "HEAD" })).headers.get("content-type"), "text/html; charset=utf-8");
  } finally { await h.close(); }
});

test("HTTP commits batch text, binary and deletes atomically within the canonical product namespace", async () => {
  const h = await harness({ labyrinth: { entitled: () => true, storage: new MemoryStorage() } });
  try {
    const owner = await h.signUp("artifact-owner");
    await h.suite.cid.createOrganization("Artifacts", owner.cid);
    const command = (action: string, args: Record<string, unknown> = {}) => h.call("POST", "/api/labyrinth", { product: "spectre", action, ...args }, owner.cookie, { "x-labyrinth": "1" });
    await command("consent", { scopes: ["repo:read", "repo:write", "repo:admin"] });
    await command("provision");
    const repo = (await command("create", { name: "artifacts" })).body;
    const bytes = Buffer.from([0, 255, 128, 5, 6]);
    const first = await command("commit", { repo: repo.id, expectedHead: null, message: "Save text and binary", changes: { "README.md": "hello", "artifact.bin": { encoding: "base64", content: bytes.toString("base64") } } });
    assert.equal(first.status, 200);
    assert.equal(Object.keys(first.body.tree).length, 2);
    assert.ok(first.body.tree["products/spectre/artifact.bin"]);
    const read = await command("load", { repo: repo.id, commit: first.body.id, path: "artifact.bin", encoding: "base64" });
    assert.equal(read.body.content, bytes.toString("base64"));
    assert.equal((await command("load", { repo: repo.id, commit: first.body.id, path: "artifact.bin" })).status, 400);
    assert.equal((await command("save", { repo: repo.id, expectedHead: first.body.id, path: "bad.bin", content: "!!!!", encoding: "base64" })).status, 400);
    const rejected = await command("commit", { repo: repo.id, expectedHead: first.body.id, message: "Traversal rejected", changes: { "valid.txt": "no partial write", "../escape.txt": "bad" } });
    assert.equal(rejected.status, 400);
    assert.equal((await command("list")).body[0].branches.main, first.body.id);
    const next = await command("commit", { repo: repo.id, expectedHead: first.body.id, message: "Replace and delete", changes: { "README.md": null, "artifact.bin": { content: "updated", encoding: "utf-8" } } });
    assert.equal(next.status, 200);
    assert.equal(Object.keys(next.body.tree).length, 1);
    assert.equal((await command("load", { repo: repo.id, commit: next.body.id, path: "artifact.bin" })).body.content, "updated");
  } finally { await h.close(); }
});

test("history cursors stay on their branch and audit pages remain bounded", async () => {
  const h = await harness({ labyrinth: { entitled: () => true, storage: new MemoryStorage() } });
  try {
    const owner = await h.signUp("pagination-owner");
    await h.suite.cid.createOrganization("Pages", owner.cid);
    const command = (action: string, args: Record<string, unknown> = {}) => h.call("POST", "/api/labyrinth", { product: "spectre", action, ...args }, owner.cookie, { "x-labyrinth": "1" });
    await command("consent", { scopes: ["repo:read", "repo:write", "repo:admin"] }); await command("provision");
    const repo = (await command("create", { name: "paged" })).body;
    const first = (await command("save", { repo: repo.id, path: "file.txt", content: "1", expectedHead: null })).body;
    await command("branch", { repo: repo.id, name: "fork", from: first.id });
    const fork = (await command("save", { repo: repo.id, branch: "fork", path: "file.txt", content: "fork", expectedHead: first.id })).body;
    const second = (await command("save", { repo: repo.id, path: "file.txt", content: "2", expectedHead: first.id })).body;
    assert.deepEqual((await command("history", { repo: repo.id, limit: 1 })).body.map((c: { id: string }) => c.id), [second.id]);
    assert.deepEqual((await command("history", { repo: repo.id, limit: 1, before: second.id })).body.map((c: { id: string }) => c.id), [first.id]);
    assert.deepEqual((await command("history", { repo: repo.id, before: first.id })).body, []);
    assert.equal((await command("history", { repo: repo.id, before: fork.id })).status, 404);
    const page = await command("audit", { after: 0, limit: 2 });
    assert.deepEqual(page.body.map((e: { sequence: number }) => e.sequence), [1, 2]);
    assert.deepEqual((await command("audit", { after: 2, limit: 2 })).body.map((e: { sequence: number }) => e.sequence), [3, 4]);
    assert.equal((await command("audit", { after: -1, limit: 2 })).status, 400);
    assert.equal((await command("audit", { after: 0, limit: 1001 })).status, 400);
  } finally { await h.close(); }
});

test("new CID users can onboard an organization without creating a free repository entitlement", async () => {
  const h = await harness({ labyrinth: { entitled: () => false, storage: new MemoryStorage() } });
  try {
    const owner = await h.signUp("onboarding-owner");
    const command = (action: string, args: Record<string, unknown> = {}, cookie = owner.cookie) => h.call("POST", "/api/labyrinth", { product: "spectre", action, ...args }, cookie, { "x-labyrinth": "1" });
    const session = await command("session"); assert.equal(session.status, 200); assert.equal(session.body.organization, null);
    assert.equal((await command("organization", { name: "Forged" }, "")).status, 401);
    assert.equal((await command("organization", { name: "   " })).status, 400);
    const org = await command("organization", { name: "New Client" }); assert.equal(org.status, 200);
    assert.equal((await command("session")).body.organization.id, org.body.id);
    assert.equal((await command("organization", { name: "Duplicate" })).status, 409);
    assert.equal((await command("consent", { scopes: ["repo:read", "repo:write", "repo:admin"] })).status, 200);
    assert.equal((await command("provision")).status, 403);
    assert.equal((await command("list")).status, 403);
  } finally { await h.close(); }
});
