import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Labyrinth, LBRNTH, LabyrinthError, MemoryStorage, EncryptedFileStorage, hashBytes, verifyAudit } from "./index.ts";
import type { CommitInput, LabyrinthOptions, Scope } from "./index.ts";

function setup(storage = new MemoryStorage()) {
  const paid = new Set(["client-a", "client-b"]);
  const denied = new Set<string>();
  const opts: LabyrinthOptions = {
    storage, entitled: (id, product) => product === "LBRNTH" && paid.has(id),
    can: (cid, product, scope) => product === "LBRNTH" && !denied.has(`${cid}:${scope}`),
    canProvision: (cid, org) => cid === (org === "client-a" ? "alice" : "bob"),
    clock: () => new Date("2026-11-07T03:00:00Z"),
  };
  const lab = new Labyrinth(opts);
  lab.createOrganization("alice", "client-a", "Client A");
  lab.createOrganization("bob", "client-b", "Client B");
  const repo = lab.createRepository("alice", "client-a", "private-code");
  return { lab, repo, paid, denied, opts, storage, sdk: lab.forClient("alice", "client-a") };
}
const error = (fn: () => unknown, code: LabyrinthError["code"]) => assert.throws(fn, (e: unknown) => e instanceof LabyrinthError && e.code === code);
function first(s: ReturnType<typeof setup>) {
  return s.sdk.commit(s.repo.id, { branch: "main", expectedHead: null, message: "Initial code", changes: { "src/main.ts": "private source", "build.bin": Uint8Array.of(0, 255, 128) } });
}

test("registers the exact client-facing product and private repository", () => {
  const s = setup();
  assert.equal(LBRNTH.id, "LBRNTH"); assert.equal(LBRNTH.name, "Labyrinth");
  assert.equal(LBRNTH.publisher, "Infinitum Corporation®");
  assert.equal(s.repo.visibility, "private");
  s.repo.branches.main = "tampered";
  assert.equal(s.sdk.repositories()[0].branches.main, null);
});

test("tenant isolation covers every repository, member, version and audit operation", () => {
  const s = setup(); const c = first(s); const lab = s.lab; const r = s.repo.id;
  const attempts = [
    () => lab.repositories("bob", "client-a"), () => lab.members("bob", "client-a"),
    () => lab.readFile("bob", "client-a", r, c.id, "src/main.ts"),
    () => lab.history("bob", "client-a", r), () => lab.diff("bob", "client-a", r, null, c.id),
    () => lab.audit("bob", "client-a"), () => lab.createRepository("bob", "client-a", "stolen"),
    () => lab.commit("bob", "client-a", r, { branch: "main", expectedHead: c.id, message: "bad", changes: { x: "bad" } }),
    () => lab.createBranch("bob", "client-a", r, "steal", c.id), () => lab.createTag("bob", "client-a", r, "v1", c.id),
    () => lab.setMember("bob", "client-a", "bob", "owner"),
  ];
  for (const attempt of attempts) error(attempt, "forbidden");
  error(() => lab.readFile("bob", "client-b", r, c.id, "src/main.ts"), "not_found");
  error(() => lab.repositories("alice", "nonexistent"), "forbidden");
});

test("organization provisioning requires trusted directory AND plan AND consent", () => {
  const s = setup();
  const lab = new Labyrinth(s.opts);
  error(() => lab.createOrganization("mallory", "client-a", "Takeover"), "forbidden");
  error(() => lab.createOrganization("alice", "unpaid", "Unpaid"), "forbidden");
  s.denied.add("alice:repo:admin");
  error(() => lab.createOrganization("alice", "client-a", "A"), "forbidden");
});

test("all operations re-check live plan entitlement and CID can grants", () => {
  const s = setup(); const c = first(s);
  s.paid.delete("client-a");
  error(() => s.sdk.repositories(), "forbidden");
  error(() => s.sdk.commit(s.repo.id, { branch: "main", expectedHead: c.id, message: "No", changes: { x: "x" } }), "forbidden");
  s.paid.add("client-a");
  for (const scope of ["repo:read", "repo:write", "repo:admin"] as Scope[]) s.denied.add(`alice:${scope}`);
  error(() => s.sdk.readFile(s.repo.id, c.id, "src/main.ts"), "forbidden");
  error(() => s.sdk.createBranch(s.repo.id, "blocked", c.id), "forbidden");
  error(() => s.lab.setMember("alice", "client-a", "bob", "reader"), "forbidden");
});

test("roles enforce reader/writer/admin, revocation, and last-owner safety", () => {
  const s = setup(); const c = first(s);
  s.lab.setMember("alice", "client-a", "reader", "reader");
  const reader = s.lab.forClient("reader", "client-a");
  assert.equal(reader.history(s.repo.id)[0].id, c.id);
  error(() => reader.createRepository("no"), "forbidden");
  error(() => s.lab.setMember("reader", "client-a", "reader", "owner"), "forbidden");
  s.lab.setMember("alice", "client-a", "writer", "writer");
  s.lab.forClient("writer", "client-a").createBranch(s.repo.id, "work", c.id);
  error(() => s.lab.setMember("writer", "client-a", "friend", "reader"), "forbidden");
  s.lab.setMember("alice", "client-a", "admin", "admin");
  error(() => s.lab.setMember("admin", "client-a", "admin", "owner"), "forbidden");
  error(() => s.lab.setMember("admin", "client-a", "alice", null), "forbidden");
  error(() => s.lab.setMember("alice", "client-a", "alice", "reader"), "conflict");
  s.lab.setMember("alice", "client-a", "reader", null);
  error(() => reader.repositories(), "forbidden");
});

test("version hashes, binary read, deletion, deterministic history and file diff", () => {
  const s = setup(); const a = first(s);
  assert.equal(a.tree["src/main.ts"], hashBytes("private source"));
  assert.deepEqual([...s.sdk.readFile(s.repo.id, a.id, "build.bin")], [0, 255, 128]);
  const b = s.sdk.commit(s.repo.id, { branch: "main", expectedHead: a.id, message: "Second", changes: { "src/main.ts": "updated", "build.bin": null, "README.md": "hello" } });
  assert.equal(b.parent, a.id);
  assert.deepEqual(s.sdk.history(s.repo.id).map(c => c.id), [b.id, a.id]);
  assert.deepEqual(s.sdk.diff(s.repo.id, a.id, b.id).map(d => [d.path, d.kind]), [["README.md", "added"], ["build.bin", "deleted"], ["src/main.ts", "modified"]]);
  assert.equal(Buffer.from(s.sdk.readFile(s.repo.id, a.id, "src/main.ts")).toString(), "private source");
  error(() => s.sdk.readFile(s.repo.id, b.id, "build.bin"), "not_found");
  a.tree["src/main.ts"] = "bad";
  assert.notEqual(s.sdk.history(s.repo.id)[1].tree["src/main.ts"], "bad");
});

test("branches isolate history, immutable tags and CAS reject stale updates", () => {
  const s = setup(); const a = first(s);
  s.sdk.createBranch(s.repo.id, "feature/code", a.id);
  const b = s.sdk.commit(s.repo.id, { branch: "feature/code", expectedHead: a.id, message: "Feature", changes: { feature: "yes" } });
  assert.equal(s.sdk.history(s.repo.id)[0].id, a.id);
  assert.equal(s.sdk.history(s.repo.id, "feature/code")[0].id, b.id);
  s.sdk.createTag(s.repo.id, "v1", a.id);
  error(() => s.sdk.createTag(s.repo.id, "v1", b.id), "conflict");
  error(() => s.sdk.commit(s.repo.id, { branch: "feature/code", expectedHead: a.id, message: "Lost", changes: { lost: "no" } }), "conflict");
  error(() => s.sdk.createBranch(s.repo.id, "feature/code", a.id), "conflict");
  error(() => s.sdk.createTag(s.repo.id, "bad", "foreign-commit"), "not_found");
});

test("rejects traversal, prototype keys, collisions and overlarge commits atomically", () => {
  const s = setup(); const a = first(s);
  const invalid = ["../escape", "/absolute", "a/../b", "a//b", "__proto__", "x/constructor", "back\\slash", "a\u0000b"];
  for (const path of invalid) {
    error(() => s.sdk.commit(s.repo.id, { branch: "main", expectedHead: a.id, message: "bad", changes: { [path]: "bad" } }), "invalid");
  }
  const badChanges: CommitInput["changes"][] = [{ src: "collision" }, { "a": "file", "a/b": "nested" }, { huge: new Uint8Array(10 * 1024 * 1024 + 1) }];
  for (const changes of badChanges) {
    error(() => s.sdk.commit(s.repo.id, { branch: "main", expectedHead: a.id, message: "bad", changes }), "invalid");
  }
  assert.equal(s.sdk.history(s.repo.id)[0].id, a.id);
  error(() => s.sdk.history(s.repo.id, "main", Infinity), "invalid");
});

test("audit chain captures successful reads, writes and membership changes without content", () => {
  const s = setup(); const a = first(s);
  s.sdk.readFile(s.repo.id, a.id, "src/main.ts");
  const audit = s.lab.audit("alice", "client-a");
  assert.ok(verifyAudit(audit));
  assert.ok(audit.some(e => e.action === "commit.create" && e.repoId === s.repo.id));
  assert.ok(audit.some(e => e.action === "object.read"));
  assert.ok(!JSON.stringify(audit).includes("private source"));
  audit[0].action = "tampered"; assert.equal(verifyAudit(audit), false);
});

test("storage failure publishes neither version, objects nor audit events", () => {
  class FailingStorage extends MemoryStorage {
    fail = false;
    override save(orgs: Parameters<MemoryStorage["save"]>[0]) { if (this.fail) throw new Error("disk unavailable"); super.save(orgs); }
  }
  const storage = new FailingStorage(); const s = setup(storage); const a = first(s);
  const before = storage.load(); storage.fail = true;
  assert.throws(() => s.sdk.commit(s.repo.id, { branch: "main", expectedHead: a.id, message: "fail", changes: { x: "uncommitted" } }), /disk unavailable/);
  assert.deepEqual(storage.load(), before); storage.fail = false;
  assert.equal(s.sdk.history(s.repo.id)[0].id, a.id);
});

test("encrypted snapshot round-trip protects full client content and metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "lbrnth-"));
  try {
    const path = join(dir, "snapshot.json");
    const keys = { "client-a": randomBytes(32), "client-b": randomBytes(32) };
    const storage = new EncryptedFileStorage(path, id => keys[id as keyof typeof keys]);
    const s = setup(); first(s); storage.save(s.storage.load());
    const raw = readFileSync(path, "utf8");
    for (const secret of ["private source", "private-code", "src/main.ts", "alice", "Initial code"]) assert.ok(!raw.includes(secret));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const restored = new Labyrinth({ ...s.opts, storage });
    assert.equal(restored.history("alice", "client-a", s.repo.id).length, 1);
    assert.throws(() => new EncryptedFileStorage(path, () => randomBytes(32)).load());
    const file = JSON.parse(raw); file.organizations[0].id = file.organizations[0].id === "client-a" ? "client-b" : "client-a";
    writeFileSync(path, JSON.stringify(file)); assert.throws(() => storage.load());
    writeFileSync(path, raw); const bad = JSON.parse(raw);
    bad.organizations[0].ciphertext = Buffer.from("tampered").toString("base64");
    writeFileSync(path, JSON.stringify(bad)); assert.throws(() => storage.load());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("snapshot integrity rejects modified objects, commits, refs and audit chains", () => {
  const s = setup(); first(s);
  for (const corrupt of [
    (o: ReturnType<MemoryStorage["load"]>) => { o[0].audit[0].action = "fake"; },
    (o: ReturnType<MemoryStorage["load"]>) => { const r = o[0].repositories[0]; r.objects[Object.keys(r.objects)[0]] = "YmFk"; },
    (o: ReturnType<MemoryStorage["load"]>) => { o[0].repositories[0].commits[0].message = "fake"; },
    (o: ReturnType<MemoryStorage["load"]>) => { o[0].repositories[0].branches.main = "nonexistent"; },
  ]) {
    // Whole-snapshot save may reorder orgs; address the client explicitly.
    const state = s.storage.load().sort((a, b) => a.id.localeCompare(b.id)); corrupt(state);
    const storage = new MemoryStorage(); storage.save(state);
    error(() => new Labyrinth({ ...s.opts, storage }), "integrity");
  }
});

test("real CID grants cannot substitute for the client organization's paid entitlement", async () => {
  const { CidService } = await import("@infinitum/cid");
  const { Ledger, generateSigner } = await import("@infinitum/firmament");
  const signer = generateSigner();
  const cid = new CidService({ ledger: new Ledger(undefined, { authorizedSigners: [signer.publicKey] }), signer, rpId: "infinitum.id", origins: ["https://infinitum.id"] });
  const account = await cid.createAccount({ username: "labyrinth-client" });
  let entitled = false;
  const lab = new Labyrinth({ can: cid.can.bind(cid), entitled: () => entitled, canProvision: (actor, org) => actor === account.cid && org === "real-client" });
  error(() => lab.createOrganization(account.cid, "real-client", "Client"), "forbidden");
  await cid.grant(account.cid, "LBRNTH", ["repo:admin", "repo:read", "repo:write"]);
  error(() => lab.createOrganization(account.cid, "real-client", "Client"), "forbidden");
  entitled = true;
  lab.createOrganization(account.cid, "real-client", "Client");
  const sdk = lab.forClient(account.cid, "real-client");
  sdk.createRepository("code"); assert.equal(sdk.repositories().length, 1);
  await cid.revoke(account.cid, "LBRNTH", ["repo:read"]);
  error(() => sdk.repositories(), "forbidden");
});


test("ordinary filenames matching Object prototype methods remain safe in diffs", () => {
  const s = setup();
  const a = s.sdk.commit(s.repo.id, { branch: "main", expectedHead: null, message: "Names", changes: { toString: "safe", valueOf: "also safe" } });
  assert.deepEqual(s.sdk.diff(s.repo.id, null, a.id).map(d => [d.path, d.kind, d.before]), [["toString", "added", null], ["valueOf", "added", null]]);
  const b = s.sdk.commit(s.repo.id, { branch: "main", expectedHead: a.id, message: "Delete", changes: { toString: null } });
  assert.equal(s.sdk.diff(s.repo.id, a.id, b.id)[0].kind, "deleted");
});

test("authorization callbacks fail closed for promises and non-boolean truthy values", () => {
  const s = setup();
  for (const field of ["can", "entitled", "canProvision"] as const) {
    for (const value of [Promise.resolve(false), {}, "true", 1]) {
      const lab = new Labyrinth({ ...s.opts, [field]: (() => value) as never });
      error(() => lab.createOrganization("alice", "client-a", "Denied"), "forbidden");
    }
  }
});

test("stale file snapshots and concurrent writers cannot overwrite another instance", () => {
  const dir = mkdtempSync(join(tmpdir(), "lbrnth-race-"));
  try {
    const key = randomBytes(32); const path = join(dir, "state.json");
    const a = new EncryptedFileStorage(path, () => key);
    const b = new EncryptedFileStorage(path, () => key);
    const s = setup(); a.save(s.storage.load());
    const baseline = b.load();
    const next = a.load(); next[0].name = "Winner"; a.save(next);
    assert.throws(() => b.save(baseline), /changed|stale|conflict/i);
    assert.equal(new EncryptedFileStorage(path, () => key).load()[0].name, "Winner");
    b.load(); writeFileSync(`${path}.lock`, "busy", { flag: "wx" });
    assert.throws(() => b.save(baseline));
    assert.equal(new EncryptedFileStorage(path, () => key).load()[0].name, "Winner");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("repository, ref, member, commit and byte quotas reject changes atomically", () => {
  for (const [limits, action] of [
    [{ repositoriesPerOrg: 1 }, (s: ReturnType<typeof setup>, lab: Labyrinth) => lab.createRepository("alice", "client-a", "overflow")],
    [{ membersPerOrg: 1 }, (s: ReturnType<typeof setup>, lab: Labyrinth) => lab.setMember("alice", "client-a", "other", "writer")],
    [{ refsPerRepository: 1 }, (s: ReturnType<typeof setup>, lab: Labyrinth) => lab.createBranch("alice", "client-a", s.repo.id, "overflow", null)],
  ] as const) {
    const s = setup(); const before = s.storage.load();
    const lab = new Labyrinth({ ...s.opts, limits });
    error(() => action(s, lab), "capacity"); assert.deepEqual(s.storage.load(), before);
  }
  const s = setup(); const a = first(s); const before = s.storage.load();
  const lab = new Labyrinth({ ...s.opts, limits: { commitsPerRepository: 1 } });
  error(() => lab.commit("alice", "client-a", s.repo.id, { branch: "main", expectedHead: a.id, message: "Overflow", changes: { more: "no" } }), "capacity");
  assert.deepEqual(s.storage.load(), before);
  const cap = Math.max(...before.map(org => Buffer.byteLength(JSON.stringify(org)))) + 100;
  const small = new Labyrinth({ ...s.opts, limits: { orgBytes: cap } });
  error(() => small.commit("alice", "client-a", s.repo.id, { branch: "main", expectedHead: a.id, message: "Big", changes: { extra: "x".repeat(2000) } }), "capacity");
  assert.deepEqual(s.storage.load(), before);
});

test("per-org rate limits reset without blocking another client", () => {
  const s = setup(); let now = 0;
  const lab = new Labyrinth({ ...s.opts, limits: { operationsPerMinute: 2 }, clock: () => new Date(now) });
  lab.repositories("alice", "client-a"); lab.repositories("alice", "client-a");
  error(() => lab.repositories("alice", "client-a"), "capacity");
  assert.deepEqual(lab.repositories("bob", "client-b"), []);
  now += 60000;
  assert.equal(lab.repositories("alice", "client-a").length, 1);
});

test("malformed payloads and oversized text are rejected before storage writes", () => {
  const s = setup(); const before = s.storage.load();
  for (const changes of [null, [], 123, { x: undefined }]) {
    error(() => s.sdk.commit(s.repo.id, { branch: "main", expectedHead: null, message: "Bad", changes: changes as never }), "invalid");
  }
  error(() => s.sdk.commit(s.repo.id, { branch: "main", expectedHead: null, message: "Huge", changes: { text: "a".repeat(10 * 1024 * 1024 + 1) } }), "invalid");
  error(() => s.lab.setMember("alice", "client-a", 123 as never, "reader"), "invalid");
  assert.deepEqual(s.storage.load(), before);
});


test("unauthorized commits are denied before inspecting or scanning any payload", () => {
  const s = setup();
  const input = { get changes() { throw new Error("Payload must not be inspected"); } };
  error(() => s.lab.commit("bob", "client-a", s.repo.id, input as never), "forbidden");
});

test("rejected async authorities are denied without unhandled rejections", async () => {
  const s = setup();
  for (const field of ["can", "entitled", "canProvision"] as const) {
    const lab = new Labyrinth({ ...s.opts, [field]: (() => Promise.reject(new Error("Authority unavailable"))) as never });
    error(() => lab.createOrganization("alice", "client-a", "Denied"), "forbidden");
  }
  await new Promise(resolve => setImmediate(resolve));
});
