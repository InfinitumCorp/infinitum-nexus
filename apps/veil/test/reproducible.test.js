import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectEntries,
  dosDateTime,
  gitHead,
  packDirectory,
  readTar,
  readZip,
  resolveSourceDateEpoch,
  writeSha256Manifest,
} from "../scripts/archive.js";
import { packageExtension } from "../scripts/package.js";
import { GO_VERSION, NODE_VERSION, PNPM_VERSION } from "../scripts/toolchain.js";

const repo = fileURLToPath(new URL("../../..", import.meta.url));
const extension = fileURLToPath(new URL("../", import.meta.url));
const epoch = 1700000000;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "veil-archive-"));
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "z.txt"), "z\n");
  writeFileSync(join(dir, "nested", "m.txt"), "m\n");
  writeFileSync(join(dir, "a.txt"), "a\n");
  chmodSync(join(dir, "a.txt"), 0o755);
  return dir;
}

test("SOURCE_DATE_EPOCH and the toolchain pins are stable inputs", () => {
  assert.equal(process.versions.node, NODE_VERSION);
  assert.equal(resolveSourceDateEpoch(extension), Number(spawnSync("git", ["log", "-1", "--format=%ct"], { cwd: extension, encoding: "utf8" }).stdout.trim()));
  assert.equal(gitHead(extension), spawnSync("git", ["rev-parse", "HEAD"], { cwd: extension, encoding: "utf8" }).stdout.trim());
  const archive = fileURLToPath(new URL("../scripts/archive.js", import.meta.url));
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import { resolveSourceDateEpoch } from ${JSON.stringify(archive)}; console.log(resolveSourceDateEpoch(${JSON.stringify(extension)}));`],
    { env: { ...process.env, SOURCE_DATE_EPOCH: String(epoch) }, encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), String(epoch));
  const workflow = readFileSync(join(repo, ".github/workflows/veil.yml"), "utf8");
  assert.match(workflow, new RegExp(`node-version:\\s*"${NODE_VERSION}"`));
  assert.match(workflow, new RegExp(`go-version:\\s*"${GO_VERSION}"`));
  assert.match(workflow, new RegExp(`version:\\s*"${PNPM_VERSION}"`));
  assert.match(workflow, /repro-check\.sh/);
  const env = readFileSync(join(repo, "apps/veil-desktop/scripts/reproducible-env.sh"), "utf8");
  const build = readFileSync(join(repo, "apps/veil-desktop/scripts/build-reproducible.sh"), "utf8");
  assert.match(env, /SOURCE_DATE_EPOCH/);
  assert.match(env, /GOTOOLCHAIN/);
  assert.match(env, /CGO_ENABLED=0/);
  assert.match(env, /-trimpath/);
  assert.match(env, /-buildvcs=false/);
  assert.match(env, /-buildid=/);
  assert.match(build, /SOURCE_DATE_EPOCH/);
  assert.match(build, /SHA256SUMS/);
});

test("zip and tar entry order, modes, and timestamps do not depend on directory order", () => {
  const dir = fixture();
  try {
    const names = collectEntries(dir).map((entry) => entry.name);
    assert.deepEqual(names, ["a.txt", "nested/", "nested/m.txt", "z.txt"]);
    const zip = readZip(packDirectory(dir, epoch, "zip"));
    const stamped = dosDateTime(epoch);
    assert.deepEqual(zip.map((entry) => entry.name), names);
    for (const entry of zip) {
      assert.equal(entry.extraLength, 0);
      assert.equal(entry.commentLength, 0);
      assert.equal(entry.dosTime, stamped.dosTime);
      assert.equal(entry.dosDate, stamped.dosDate);
    }
    const executable = zip.find((entry) => entry.name === "a.txt");
    assert.equal(executable.external >>> 16, 0o100755);
    const tar = readTar(packDirectory(dir, epoch, "tar"));
    assert.deepEqual(tar.map((entry) => entry.name), names);
    for (const entry of tar) assert.equal(entry.mtime, epoch);
    assert.equal(tar.find((entry) => entry.name === "a.txt").mode, 0o755);
    assert.equal(tar.find((entry) => entry.name === "z.txt").mode, 0o644);
    assert.equal(packDirectory(dir, epoch, "zip").equals(packDirectory(dir, epoch, "zip")), true);
    assert.equal(packDirectory(dir, epoch, "tar").equals(packDirectory(dir, epoch, "tar")), true);
    assert.equal(packDirectory(dir, epoch + 1, "tar").equals(packDirectory(dir, epoch, "tar")), false);
    assert.equal(packDirectory(dir, epoch + 2, "zip").equals(packDirectory(dir, epoch, "zip")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the archive CLI writes the same zip and tar twice and a sha256sum manifest", () => {
  const dir = fixture();
  const out = mkdtempSync(join(tmpdir(), "veil-archive-out-"));
  try {
    const cli = fileURLToPath(new URL("../scripts/archive.js", import.meta.url));
    for (const format of ["zip", "tar"]) {
      const first = join(out, `one.${format}`);
      const second = join(out, `two.${format}`);
      for (const target of [first, second]) {
        const result = spawnSync(process.execPath, [cli, "pack", "--base", dir, "--out", target, "--format", format, "--epoch", String(epoch)], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
      assert.equal(readFileSync(first).equals(readFileSync(second)), true);
    }
    const listed = spawnSync("tar", ["-tf", join(out, "one.tar")], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(listed.stdout.split("\n").filter(Boolean), ["a.txt", "nested/", "nested/m.txt", "z.txt"]);
    const unzipped = spawnSync("unzip", ["-t", join(out, "one.zip")], { encoding: "utf8" });
    assert.equal(unzipped.status, 0, unzipped.stderr);
    writeFileSync(join(dir, "BUILDINFO"), "UNSIGNED=1\n");
    writeSha256Manifest(dir);
    const check = spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: dir, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
    symlinkSync("a.txt", join(dir, "link.txt"));
    assert.throws(() => collectEntries(dir), /symlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("two extension packages share zip bytes, tar bytes, and the SHA-256 manifest", () => {
  const first = mkdtempSync(join(tmpdir(), "veil-pkg-a-"));
  const second = mkdtempSync(join(tmpdir(), "veil-pkg-b-"));
  try {
    packageExtension(extension, first, { sourceDateEpoch: epoch, gitCommit: "abc123" });
    packageExtension(extension, second, { sourceDateEpoch: epoch, gitCommit: "abc123" });
    const manifest = readFileSync(join(first, "SHA256SUMS"), "utf8");
    assert.equal(manifest, readFileSync(join(second, "SHA256SUMS"), "utf8"));
    for (const line of manifest.trim().split("\n")) {
      const path = line.slice(line.indexOf("  ") + 2);
      assert.equal(readFileSync(join(first, path)).equals(readFileSync(join(second, path))), true, path);
    }
    const check = spawnSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: first, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
    const info = readFileSync(join(first, "BUILDINFO"), "utf8");
    assert.match(info, new RegExp(`SOURCE_DATE_EPOCH=${epoch}`));
    assert.match(info, /UNSIGNED=1/);
    assert.match(info, new RegExp(`NODE_VERSION=${NODE_VERSION}`));
    const zipNames = readZip(readFileSync(join(first, "veil-chrome.zip"))).map((entry) => entry.name);
    assert.deepEqual(zipNames, [...zipNames].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    const tarNames = readTar(readFileSync(join(first, "veil-firefox.tar"))).map((entry) => entry.name);
    assert.deepEqual(tarNames, [...tarNames].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    assert.equal(zipNames.some((name) => name.startsWith("server/") || name.startsWith("test/")), false);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
