import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CidService } from "@infinitum/cid";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { VirtualAuthenticator } from "../../cid/src/testing/virtual-authenticator.ts";
import { CidLabyrinth, LabyrinthError, labyrinthFromEnvironment } from "./index.ts";

const clock = () => new Date("2026-11-07T12:00:00Z");
const masterKey = (fill: number) => Buffer.alloc(32, fill).toString("base64");

async function signedInClient() {
  const signer = generateSigner();
  const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
  const cid = new CidService({ ledger, signer, rpId: "localhost", origins: ["http://localhost"], clock });
  const account = await cid.createAccount({ username: "release-owner" });
  const org = await cid.createOrganization("Release client", account.cid);
  const authenticator = new VirtualAuthenticator();
  const registration = await cid.startAuthenticatorRegistration(account.cid, "passkey");
  const credential = await cid.finishAuthenticatorRegistration(account.cid, authenticator.create({ challenge: registration.challenge, rpId: "localhost", origin: "http://localhost" }), { kind: "passkey" });
  const challenge = await cid.startSignIn();
  const signIn = await cid.finishSignIn(authenticator.get({ credentialId: credential.credentialId, challenge: challenge.challenge, origin: "http://localhost" }), "test");
  assert.equal(signIn.status, "ok");
  if (signIn.status !== "ok") throw new Error("Unexpected MFA");
  await cid.grant(account.cid, "LBRNTH", ["repo:read", "repo:write", "repo:admin"]);
  return { cid, org, token: signIn.token };
}

function deploymentEnv(path: string, fill: number, orgId = "") {
  const env = { LBRNTH_MASTER_KEY: masterKey(fill), LBRNTH_ENTITLED_ORGS: orgId };
  const config = labyrinthFromEnvironment(env, path);
  if (!config) throw new Error("Expected deployment config");
  return { env, config };
}

test("deployment config fails closed until an operator supplies a canonical key and allowlist", () => {
  const dir = mkdtempSync(join(tmpdir(), "lbrnth-release-config-"));
  const path = join(dir, "labyrinth.json");
  try {
    assert.equal(labyrinthFromEnvironment({}, path), undefined);
    assert.equal(labyrinthFromEnvironment({ LBRNTH_MASTER_KEY: "" }, path), undefined);
    const canonical = masterKey(9);
    for (const bad of [canonical.slice(0, -1), `${canonical}\n`, ` ${canonical}`, Buffer.alloc(31, 9).toString("base64"), Buffer.alloc(33, 9).toString("base64"), canonical.replace(/=+$/, ""), "not-base64!!"]) {
      assert.throws(() => labyrinthFromEnvironment({ LBRNTH_MASTER_KEY: bad }, path), /canonical base64 32-byte/);
    }
    const env: { LBRNTH_MASTER_KEY: string; LBRNTH_ENTITLED_ORGS?: string } = { LBRNTH_MASTER_KEY: canonical, LBRNTH_ENTITLED_ORGS: " org-a, org-b, , org-a " };
    const config = labyrinthFromEnvironment(env, path)!;
    assert.equal(existsSync(path), false, "parsing config must not create a snapshot");
    assert.equal(config.entitled("org-a", "LBRNTH"), true);
    assert.equal(config.entitled("org-b", "LBRNTH"), true);
    assert.equal(config.entitled("org-c", "LBRNTH"), false);
    env.LBRNTH_ENTITLED_ORGS = "";
    assert.equal(config.entitled("org-a", "LBRNTH"), false);
    delete env.LBRNTH_ENTITLED_ORGS;
    assert.equal(config.entitled("org-a", "LBRNTH"), false);
    env.LBRNTH_MASTER_KEY = masterKey(8);
    assert.equal(config.entitled("org-a", "LBRNTH"), false, "allowlist stays fail-closed after a key edit");
    const reread = labyrinthFromEnvironment({ ...env, LBRNTH_ENTITLED_ORGS: "org-a" }, path)!;
    assert.notEqual(reread.storage, config.storage);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("key lifecycle keeps the master key out of the snapshot, isolates orgs, and requires explicit re-encryption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lbrnth-release-keys-"));
  const path = join(dir, "private", "labyrinth.json");
  try {
    const session = await signedInClient();
    const first = deploymentEnv(path, 1, session.org.id);
    const service = new CidLabyrinth(session.cid.syncView(), { ...first.config, clock });
    service.provision(session.token);
    const repo = service.forProduct(session.token, "spectre").createRepository("release");
    const saved = service.forProduct(session.token, "spectre").save(repo.id, "note.txt", "release-secret", null);
    const raw = readFileSync(path, "utf8");
    // Windows has no POSIX permission bits (it reports 0o666), so check them only elsewhere.
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    // Windows has no POSIX permission bits (it reports 0o666), so check them only elsewhere.
    if (process.platform !== "win32") assert.equal(statSync(join(dir, "private")).mode & 0o777, 0o700);
    for (const secret of ["release-secret", first.env.LBRNTH_MASTER_KEY, session.token, "note.txt"]) assert.equal(raw.includes(secret), false);

    const restarted = new CidLabyrinth(session.cid.syncView(), { ...labyrinthFromEnvironment(first.env, path)!, clock });
    assert.equal(Buffer.from(restarted.forProduct(session.token, "spectre").load(repo.id, saved.id, "note.txt")).toString(), "release-secret");

    const captured = first.env.LBRNTH_MASTER_KEY;
    first.env.LBRNTH_MASTER_KEY = masterKey(2);
    assert.equal(Buffer.from(restarted.forProduct(session.token, "spectre").load(repo.id, saved.id, "note.txt")).toString(), "release-secret", "a running process keeps the key captured at startup");
    assert.throws(() => labyrinthFromEnvironment(first.env, path)!.storage.load());
    assert.throws(() => deploymentEnv(path, 4, session.org.id).config.storage.load());

    const orgs = labyrinthFromEnvironment({ LBRNTH_MASTER_KEY: captured, LBRNTH_ENTITLED_ORGS: session.org.id }, path)!.storage.load();
    const rotatedPath = join(dir, "rotated.json");
    deploymentEnv(rotatedPath, 2, session.org.id).config.storage.save(orgs);
    assert.throws(() => deploymentEnv(rotatedPath, 1, session.org.id).config.storage.load());
    const rotated = deploymentEnv(rotatedPath, 2, session.org.id).config.storage.load();
    assert.equal(rotated.length, 1);
    assert.equal(rotated[0]!.repositories[0]!.name, "release");
    assert.equal(readFileSync(rotatedPath, "utf8").includes("release-secret"), false);

    const swappedPath = join(dir, "swapped.json");
    const envelope = JSON.parse(raw) as { organizations: { id: string }[] };
    envelope.organizations[0]!.id = "org_other";
    writeFileSync(swappedPath, JSON.stringify(envelope));
    assert.throws(() => labyrinthFromEnvironment({ LBRNTH_MASTER_KEY: captured, LBRNTH_ENTITLED_ORGS: "org_other" }, swappedPath)!.storage.load());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("snapshot restore reloads a new service, and a stale lock or tampered envelope does not replace it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lbrnth-release-restore-"));
  const path = join(dir, "labyrinth.json");
  try {
    const session = await signedInClient();
    const env = { LBRNTH_MASTER_KEY: masterKey(5), LBRNTH_ENTITLED_ORGS: session.org.id };
    const live = new CidLabyrinth(session.cid.syncView(), { ...labyrinthFromEnvironment(env, path)!, clock });
    live.provision(session.token);
    const client = live.forProduct(session.token, "spectre");
    const repo = client.createRepository("archive");
    const saved = client.save(repo.id, "src/main.ts", "export const kept = true;\n", null);
    const intact = readFileSync(path, "utf8");

    mkdirSync(join(dir, "nested"), { recursive: true });
    const lock = `${path}.lock`;
    writeFileSync(lock, "", { flag: "wx", mode: 0o600 });
    assert.throws(() => client.save(repo.id, "src/main.ts", "export const replaced = true;\n", saved.id));
    assert.equal(readFileSync(path, "utf8"), intact);
    rmSync(lock);

    const restored = new CidLabyrinth(session.cid.syncView(), { ...labyrinthFromEnvironment({ ...env }, path)!, clock });
    assert.equal(Buffer.from(restored.forProduct(session.token, "spectre").load(repo.id, saved.id, "src/main.ts")).toString(), "export const kept = true;\n");
    const again = restored.forProduct(session.token, "spectre").save(repo.id, "src/next.ts", "restored write", saved.id);
    const cold = new CidLabyrinth(session.cid.syncView(), { ...labyrinthFromEnvironment({ ...env }, path)!, clock });
    assert.equal(Buffer.from(cold.forProduct(session.token, "spectre").load(repo.id, again.id, "src/next.ts")).toString(), "restored write");

    const tampered = JSON.parse(intact) as { organizations: { ciphertext: string }[] };
    tampered.organizations[0]!.ciphertext = Buffer.from("tampered-envelope").toString("base64");
    writeFileSync(path, JSON.stringify(tampered));
    assert.throws(() => new CidLabyrinth(session.cid.syncView(), { ...labyrinthFromEnvironment({ ...env }, path)!, clock }));
    writeFileSync(path, intact);
    const readable = new CidLabyrinth(session.cid.syncView(), { ...labyrinthFromEnvironment({ ...env }, path)!, clock });
    assert.equal(Buffer.from(readable.forProduct(session.token, "spectre").load(repo.id, saved.id, "src/main.ts")).toString(), "export const kept = true;\n");

    const broken = labyrinthFromEnvironment({ ...env }, path)!.storage.load();
    const objectId = Object.keys(broken[0]!.repositories[0]!.objects)[0]!;
    broken[0]!.repositories[0]!.objects[objectId] = Buffer.from("corrupted").toString("base64");
    const corruptPath = join(dir, "corrupt.json");
    labyrinthFromEnvironment({ ...env }, corruptPath)!.storage.save(broken);
    assert.throws(() => new CidLabyrinth(session.cid.syncView(), { ...labyrinthFromEnvironment({ ...env }, corruptPath)!, clock }), (error: unknown) => error instanceof LabyrinthError && error.code === "integrity");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
