import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { labyrinthFromEnvironment } from "./configuration.ts";
import { Labyrinth } from "./service.ts";
import { maintainLabyrinth } from "./operator.ts";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lbrnth-maintenance-"));
  const source = join(dir, "snapshot.json");
  const env = { LBRNTH_MASTER_KEY: Buffer.alloc(32, 51).toString("base64"), LBRNTH_NEXT_MASTER_KEY: Buffer.alloc(32, 52).toString("base64"), LBRNTH_ENTITLED_ORGS: "client" };
  const config = labyrinthFromEnvironment(env, source)!;
  const lab = new Labyrinth({ ...config, can: () => true, canProvision: () => true });
  lab.createOrganization("owner", "client", "Client");
  const repo = lab.createRepository("owner", "client", "private");
  const commit = lab.commit("owner", "client", repo.id, { branch: "main", expectedHead: null, message: "initial", changes: { "file.txt": "private source" } });
  return { dir, source, env, repo, commit };
}
test("offline verify, encrypted backup, restore and key rotation preserve source and refuse overwrite", () => {
  const s = fixture();
  try {
    const original = readFileSync(s.source, "utf8");
    assert.deepEqual(maintainLabyrinth("verify", s.source, undefined, s.env), { action: "verify", organizations: 1, verified: true });
    const backup = join(s.dir, "backup.json");
    maintainLabyrinth("backup", s.source, backup, s.env);
    assert.equal(readFileSync(backup, "utf8"), original);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.throws(() => maintainLabyrinth("backup", s.source, backup, s.env));
    const rotated = join(s.dir, "rotated.json");
    maintainLabyrinth("rotate", s.source, rotated, s.env);
    assert.equal(readFileSync(s.source, "utf8"), original);
    assert.equal(statSync(rotated).mode & 0o777, 0o600);
    assert.equal(readFileSync(rotated, "utf8").includes("private source"), false);
    assert.throws(() => maintainLabyrinth("verify", rotated, undefined, s.env));
    const nextEnv = { ...s.env, LBRNTH_MASTER_KEY: s.env.LBRNTH_NEXT_MASTER_KEY };
    const restored = new Labyrinth({ ...labyrinthFromEnvironment(nextEnv, rotated)!, can: () => true, canProvision: () => true });
    assert.equal(Buffer.from(restored.readFile("owner", "client", s.repo.id, s.commit.id, "file.txt")).toString(), "private source");
    assert.throws(() => maintainLabyrinth("rotate", s.source, s.source, s.env));
    assert.throws(() => maintainLabyrinth("rotate", s.source, join(s.dir, "bad.json"), { ...s.env, LBRNTH_NEXT_MASTER_KEY: s.env.LBRNTH_MASTER_KEY }));
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
test("maintenance refuses writer locks and tampered snapshots without publishing a backup", () => {
  const s = fixture();
  try {
    writeFileSync(`${s.source}.lock`, "operator must inspect");
    assert.throws(() => maintainLabyrinth("verify", s.source, undefined, s.env));
    assert.equal(readFileSync(`${s.source}.lock`, "utf8"), "operator must inspect");
    rmSync(`${s.source}.lock`);
    const envelope = JSON.parse(readFileSync(s.source, "utf8"));
    envelope.organizations[0].tag = Buffer.alloc(16, 0).toString("base64");
    writeFileSync(s.source, JSON.stringify(envelope));
    const backup = join(s.dir, "bad-backup.json");
    assert.throws(() => maintainLabyrinth("backup", s.source, backup, s.env));
    assert.throws(() => statSync(backup));
    assert.throws(() => statSync(`${s.source}.lock`));
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
