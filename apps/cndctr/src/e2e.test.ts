import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { startTestIdp, type TestIdp } from "./test-idp.ts";

const appRoot = join(import.meta.dirname, "..");
const secret = "cndctr-test-secret-not-for-production";

test("signs in and performs a VEIL Ask against the source server and the production build", { timeout: 120_000 }, async () => {
  const idpPort = await freePort();
  const idp = await startTestIdp(idpPort, "cndctr");
  let child: ChildProcess | undefined;
  try {
    child = await startServer(await listenEnv(idp), ["--experimental-strip-types", join(appRoot, "src", "server.ts")]);
    await exercise(idp);
    await stop(child);
    child = undefined;
    await build();
    child = await startServer(await listenEnv(idp), [join(appRoot, "dist", "server.js")]);
    await exercise(idp);
  } finally {
    if (child) await stop(child);
    await idp.close();
  }
});

async function exercise(idp: TestIdp): Promise<void> {
  const origin = process.env.CNDCTR_TEST_ORIGIN ?? "";
  assert.ok(origin);
  const health = await fetch(`${origin}/health`, { headers: { authorization: "Bearer not-a-token" } });
  assert.equal(health.status, 200);
  const healthBody = await health.json() as { ok: boolean; service: string };
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.service, "cndctr");

  const html = await (await fetch(`${origin}/`)).text();
  assert.match(html, /CNDCTR/);
  assert.match(html, /Conductor/);
  assert.match(html, /Infinitum Corporation®/);
  assert.match(html, /Sign in with Cumulus ID/);
  assert.match(html, /id="perform"/);
  assert.equal(html.includes(secret), false);
  const js = await (await fetch(`${origin}/app.js`)).text();
  assert.match(js, /\/api\/perform/);
  assert.equal((await fetch(`${origin}/app.css`)).status, 200);

  const config = await (await fetch(`${origin}/api/config`)).json() as { audience: string; issuer: string; publisher: string };
  assert.equal(config.audience, "cndctr");
  assert.equal(config.issuer, idp.issuer);
  assert.equal(config.publisher, "Infinitum Corporation®");
  assert.equal(JSON.stringify(config).includes(secret), false);

  const anonymous = await fetch(`${origin}/api/perform`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: "Summarize the launch", autonomy: "rehearsal" }),
  });
  assert.equal(anonymous.status, 401);

  const veil = await perform(origin, idp.token("william"), {
    intent: "Summarize the launch\n\n(Page the user shared: Pricing — https://example.com/pricing)",
    autonomy: "rehearsal",
  });
  assert.equal(veil.status, 200);
  const body = await veil.json() as { score: { autonomy: string }; performance: { verified: boolean }; evidenceHash: string };
  assert.equal(body.score.autonomy, "rehearsal");
  assert.equal(body.performance.verified, true);
  assert.equal(typeof body.evidenceHash, "string");
  assert.ok(body.evidenceHash.length > 0);

  assert.equal((await perform(origin, idp.token("william", { aud: "account", azp: "other" }), { intent: "no", autonomy: "rehearsal" })).status, 401);
  assert.equal((await perform(origin, idp.token("william", { iss: "https://evil.example" }), { intent: "no", autonomy: "rehearsal" })).status, 401);
  assert.equal((await perform(origin, idp.token("william", { exp: Math.floor(Date.now() / 1000) - 120 }), { intent: "no", autonomy: "rehearsal" })).status, 401);

  const me = await (await fetch(`${origin}/api/me`, { headers: { authorization: `Bearer ${idp.token("william")}` } })).json() as { username: string };
  assert.equal(me.username, "william");

  const login = await fetch(`${origin}/api/auth/login?login_hint=william`, { redirect: "manual" });
  assert.equal(login.status, 302);
  const atIdp = await fetch(login.headers.get("location") ?? "", { redirect: "manual" });
  assert.equal(atIdp.status, 302);
  const done = await fetch(atIdp.headers.get("location") ?? "", { redirect: "manual" });
  assert.equal(done.status, 302);
  const cookie = (done.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  assert.match(cookie, /^cndctr_session=/);

  const signedIn = await fetch(`${origin}/api/me`, { headers: { cookie } });
  assert.equal(signedIn.status, 200);
  const withCookie = await fetch(`${origin}/api/perform`, {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify({ intent: "Summarize the launch", autonomy: "rehearsal" }),
  });
  assert.equal(withCookie.status, 200);
  const rejected = await fetch(`${origin}/api/perform`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ intent: "Summarize the launch", autonomy: "rehearsal" }),
  });
  assert.equal(rejected.status, 403);

  const logout = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie, origin } });
  assert.equal(logout.status, 204);
  assert.equal((await fetch(`${origin}/api/me`, { headers: { cookie } })).status, 401);
  assert.equal((await fetch(`${origin}/api/me`, { headers: { authorization: `Bearer ${idp.token("william")}` } })).status, 200);
}

function perform(origin: string, bearer: string, body: unknown): Promise<Response> {
  return fetch(`${origin}/api/perform`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function listenEnv(idp: TestIdp): Promise<NodeJS.ProcessEnv> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  process.env.CNDCTR_TEST_ORIGIN = origin;
  return childEnv({
    PORT: String(port),
    CNDCTR_BIND: "127.0.0.1",
    CNDCTR_PUBLIC_ORIGIN: origin,
    CNDCTR_JWT_ISSUER: idp.issuer,
    CNDCTR_OIDC_CLIENT_ID: "cndctr",
    CNDCTR_OIDC_CLIENT_SECRET: secret,
    ARCHITECT_RESEARCH_FIXTURE: "1",
  });
}

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if ((key.startsWith("CNDCTR_") || key === "CUMULUS_ID_HOST" || key === "CUMULUS_KEYCLOAK_REALM") && !(key in extra)) delete env[key];
  }
  return env;
}

function startServer(env: NodeJS.ProcessEnv, args: string[]): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: appRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`server did not listen\n${out}\n${err}`));
    }, 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (!settled && /CNDCTR listening on http:\/\/\S+/.test(out)) {
        settled = true;
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString();
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited ${code}\n${out}\n${err}`));
    });
  });
}

function build(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/build.mjs"], { cwd: appRoot, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`build exited ${code}\n${out}`));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const killer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  await exited;
  clearTimeout(killer);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
