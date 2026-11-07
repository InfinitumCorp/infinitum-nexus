/** Real container smoke test. Builds are separate; this never touches an existing deployment. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { VirtualAuthenticator } from "../packages/cid/src/testing/virtual-authenticator.ts";

const temporary = mkdtempSync(join(tmpdir(), "labyrinth-runtime-"));
const project = `labyrinth-test-${randomUUID().slice(0, 8)}`;
const environment = join(temporary, "runtime.env");
const composeFile = resolve("deploy/labyrinth/compose.yaml");
const probe = createServer();
await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
const port = (probe.address() as { port: number }).port;
await new Promise<void>(resolve => probe.close(() => resolve()));
const origin = `http://localhost:${port}`;
const base = `http://127.0.0.1:${port}`;
const secret = randomBytes(32).toString("base64");
const compose = (...args: string[]) => {
  const result = spawnSync("docker", ["compose", "--project-name", project, "--env-file", environment, "-f", composeFile, ...args], { encoding: "utf8", timeout: 150_000 });
  if (result.status !== 0) throw new Error(`Isolated container command failed (${args[0]}): ${result.stderr}`);
};
const configure = (org = "", key = secret, snapshot = "/var/lib/labyrinth/labyrinth.json") => writeFileSync(environment, `LABYRINTH_PORT=${port}\nLABYRINTH_ORIGIN=${origin}\nLBRNTH_MASTER_KEY=${key}\nLBRNTH_ENTITLED_ORGS=${org}\nLBRNTH_SNAPSHOT_FILE=${snapshot}\n`, { mode: 0o600 });
let cookie = "";
async function call(path: string, body: unknown, labyrinth = false) {
  const response = await fetch(base + path, { method: "POST", headers: { "connection": "close", "content-type": "application/json", [labyrinth ? "x-labyrinth" : "x-spectre"]: "1", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const set = response.headers.get("set-cookie"); if (set) cookie = set.split(";")[0];
  return { status: response.status, body: await response.json() as any };
}
const command = (action: string, args: Record<string, unknown> = {}) => call("/api/labyrinth", { action, product: "spectre", ...args }, true);
try {
  configure(); compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "90");
  assert.equal((await fetch(base + "/labyrinth", { headers: { connection: "close" } })).status, 200);
  assert.equal((await command("session")).status, 401);
  const authenticator = new VirtualAuthenticator();
  const signup = await call("/api/auth/signup", { username: "runtime-client" }); assert.equal(signup.status, 200);
  const registered = await call("/api/auth/signup/finish", { cid: signup.body.cid, response: authenticator.create({ challenge: signup.body.options.challenge, origin, rpId: "localhost" }) }); assert.equal(registered.status, 200);
  const signed = await call("/api/auth/signin/finish", { response: authenticator.get({ credentialId: [...authenticator.credentials.keys()][0], challenge: registered.body.options.challenge, origin }) }); assert.equal(signed.status, 200);
  assert.equal((await command("session")).body.organization, null);
  const organization = await command("organization", { name: "Runtime Client" }); assert.equal(organization.status, 200);
  assert.equal((await command("consent", { scopes: ["repo:read", "repo:write", "repo:admin"] })).status, 200);
  assert.equal((await command("provision")).status, 403); // No free entitlement from onboarding.
  configure(organization.body.id);
  compose("up", "-d", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "90");
  assert.equal((await command("provision")).status, 200);
  const repo = await command("create", { name: "runtime-artifacts" }); assert.equal(repo.status, 200);
  const bytes = Buffer.from([0, 255, 128, 1, 2]);
  const saved = await command("save", { repo: repo.body.id, path: "artifact.bin", content: bytes.toString("base64"), encoding: "base64", expectedHead: null }); assert.equal(saved.status, 200);
  compose("restart");
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if ((await command("session")).status === 200) break; } catch { /* restarting */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const restored = await command("load", { repo: repo.body.id, commit: saved.body.id, path: "artifact.bin", encoding: "base64" });
  assert.equal(restored.status, 200); assert.equal(restored.body.content, bytes.toString("base64"));
  assert.equal((await command("history", { repo: repo.body.id })).body[0].id, saved.body.id);
  compose("stop", "labyrinth");
  const maintain = (action: string, destination?: string) => compose("run", "--rm", "--no-deps", "labyrinth", "node", "--experimental-strip-types", "scripts/labyrinth-maintain.ts", action, "/var/lib/labyrinth/labyrinth.json", ...(destination ? [destination] : []));
  maintain("verify"); maintain("backup", "/var/lib/labyrinth/backups/verified.json");
  const nextKey = randomBytes(32).toString("base64");
  const previousNext = process.env.LBRNTH_NEXT_MASTER_KEY;
  process.env.LBRNTH_NEXT_MASTER_KEY = nextKey;
  try {
    compose("run", "--rm", "--no-deps", "-e", "LBRNTH_NEXT_MASTER_KEY", "labyrinth", "node", "--experimental-strip-types", "scripts/labyrinth-maintain.ts", "rotate", "/var/lib/labyrinth/labyrinth.json", "/var/lib/labyrinth/labyrinth-rotated.json");
  } finally {
    if (previousNext === undefined) delete process.env.LBRNTH_NEXT_MASTER_KEY; else process.env.LBRNTH_NEXT_MASTER_KEY = previousNext;
  }
  configure(organization.body.id, nextKey, "/var/lib/labyrinth/labyrinth-rotated.json");
  compose("up", "-d", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "90");
  const rekeyed = await command("load", { repo: repo.body.id, commit: saved.body.id, path: "artifact.bin", encoding: "base64" });
  assert.equal(rekeyed.status, 200); assert.equal(rekeyed.body.content, bytes.toString("base64"));
  console.log("Labyrinth container passed: real CID signup, organization onboarding, paid-plan denial/activation, encrypted binary commit and persisted session/history/content after restart, offline integrity/backup and restored binary content after key rotation.");
} catch (error) {
  const logs = spawnSync("docker", ["compose", "--project-name", project, "--env-file", environment, "-f", composeFile, "logs", "--no-color", "--tail", "50"], { encoding: "utf8" });
  console.error(logs.stdout);
  throw error;
} finally {
  try { compose("down", "--volumes"); } finally { rmSync(temporary, { recursive: true, force: true }); }
}
