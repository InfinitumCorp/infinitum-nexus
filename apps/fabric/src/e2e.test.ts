import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FabricClient } from "./client.ts";
import { startTestIdp } from "./test-idp.ts";

const appRoot = join(import.meta.dirname, "..");

test("starts the server and runs login, conversation, send, and receive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-e2e-"));
  const idpPort = await freePort();
  const appPort = await freePort();
  const idp = await startTestIdp(idpPort, "fabric");
  const origin = `http://127.0.0.1:${appPort}`;
  const phrase = `sealed-phrase-${randomBytes(8).toString("hex")}`;
  const env = childEnv({
    PORT: String(appPort),
    FABRIC_BIND: "127.0.0.1",
    FABRIC_PUBLIC_ORIGIN: origin,
    FABRIC_JWT_ISSUER: idp.issuer,
    FABRIC_OIDC_CLIENT_ID: "fabric",
    FABRIC_DATA_DIR: dir,
    FABRIC_MASTER_KEY: randomBytes(32).toString("base64"),
    FABRIC_ROOT_DOMAIN: "infinitumfabric.app",
  });
  let child: ChildProcess | undefined;
  try {
    child = await startServer(env);
    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json() as { status: string; issuer: string; rootDomain: string };
    assert.equal(healthBody.status, "ok");
    assert.equal(healthBody.issuer, idp.issuer);
    assert.equal(healthBody.rootDomain, "infinitumfabric.app");

    const html = await (await fetch(`${origin}/`)).text();
    assert.match(html, /Sign in with Cumulus:\/\/ID/);
    assert.match(html, /id="sessions"/);
    assert.match(html, /id="send"/);
    assert.match(html, /id="text"/);
    const js = await (await fetch(`${origin}/app.js`)).text();
    assert.match(js, /\/api\/sessions/);
    assert.match(js, /messages/);
    assert.equal((await fetch(`${origin}/app.css`)).status, 200);
    assert.equal((await fetch(`${origin}/app-shell.css`)).status, 200);

    const alice = new FabricClient(origin);
    const bob = new FabricClient(origin);
    const aliceProfile = await alice.login("alice");
    const bobProfile = await bob.login("bob");
    assert.equal(aliceProfile.username, "alice");
    assert.equal(bobProfile.username, "bob");
    assert.notEqual(aliceProfile.sub, bobProfile.sub);

    const session = await alice.openSession("bob");
    const sent = await alice.sendMessage(session.id, phrase);
    assert.equal(sent.text, phrase);
    const received = await bob.receive(session.id);
    assert.equal(received[0]?.text, phrase);
    assert.equal(received[0]?.username, "alice");
    assert.equal((await bob.sessions())[0]?.preview, phrase);
    assert.equal((await bob.openSession("alice")).id, session.id);

    const cara = new FabricClient(origin);
    await cara.login("cara");
    await assert.rejects(() => cara.receive(session.id), /404 not found/);
    assert.equal((await fetch(`${origin}/api/sessions`)).status, 401);

    const bearer = await FabricClient.bearer(origin, idp.token("alice"), "/api/me");
    assert.equal(bearer.status, 200);
    const wrongIssuer = await FabricClient.bearer(origin, idp.token("alice", { iss: "https://evil.example" }), "/api/sessions");
    assert.equal(wrongIssuer.status, 401);
    const expired = await FabricClient.bearer(origin, idp.token("alice", { exp: Math.floor(Date.now() / 1000) - 120 }), "/api/sessions");
    assert.equal(expired.status, 401);

    const metrics = await (await fetch(`${origin}/metrics`)).text();
    assert.match(metrics, /^fabric_up 1$/m);
    assert.match(metrics, /^fabric_messages [1-9]/m);
    assert.match(metrics, /^fabric_sessions [1-9]/m);
    assert.match(metrics, /fabric_http_requests_total\{method="GET",status="200"\}/);

    if (!child) throw new Error("server missing");
    await stop(child);
    child = undefined;
    for (const suffix of ["", "-wal", "-shm"]) {
      const file = join(dir, "fabric.sqlite") + suffix;
      if (existsSync(file)) assert.equal(readFileSync(file).includes(phrase), false, suffix || "db");
    }

    child = await startServer(env);
    const returned = new FabricClient(origin);
    await returned.login("alice");
    const persisted = await returned.receive(session.id);
    assert.equal(persisted[0]?.text, phrase);
    await returned.logout();
    await assert.rejects(() => returned.sessions(), /401 unauthorized/);
  } finally {
    if (child) await stop(child);
    await idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("team chat over HTTP: workspace, channel, thread, reaction, file, search and live events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fabric-team-e2e-"));
  const idpPort = await freePort();
  const appPort = await freePort();
  const idp = await startTestIdp(idpPort, "fabric");
  const origin = `http://127.0.0.1:${appPort}`;
  const phrase = `team-phrase-${randomBytes(8).toString("hex")}`;
  const env = childEnv({
    PORT: String(appPort),
    FABRIC_BIND: "127.0.0.1",
    FABRIC_PUBLIC_ORIGIN: origin,
    FABRIC_JWT_ISSUER: idp.issuer,
    FABRIC_OIDC_CLIENT_ID: "fabric",
    FABRIC_DATA_DIR: dir,
    FABRIC_MASTER_KEY: randomBytes(32).toString("base64"),
  });
  let child: ChildProcess | undefined;
  try {
    child = await startServer(env);
    const page = await (await fetch(`${origin}/team`)).text();
    assert.match(page, /Sign in with Cumulus ID/);
    assert.match(page, /Create a Cumulus ID/);
    assert.equal((await fetch(`${origin}/team.js`)).status, 200);
    assert.equal((await fetch(`${origin}/api/team/workspaces`)).status, 401);
    const register = await fetch(`${origin}/api/auth/login?register=1&return=/team`, { redirect: "manual" });
    assert.match(register.headers.get("location") ?? "", /\/protocol\/openid-connect\/registrations\?/);

    const alice = new FabricClient(origin);
    const bob = new FabricClient(origin);
    await alice.login("alice");
    await bob.login("bob");
    const ws = await alice.api("POST", "/api/team/workspaces", { name: "Acme" });
    await bob.api("POST", "/api/team/join", { code: ws.inviteCode });
    const bar = await bob.api("GET", `/api/team/workspaces/${ws.id}`);
    const general = bar.channels.find((c: { name: string }) => c.name === "general");
    assert.ok(general);

    const events = await bob.raw("/api/team/events");
    assert.equal(events.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = events.body!.getReader();
    const seen: string[] = [];
    const pump = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        seen.push(decoder.decode(value));
      }
    })().catch(() => {});

    const sent = await alice.api("POST", `/api/team/channels/${general.id}/messages`, { text: `${phrase} @bob` });
    assert.deepEqual(sent.message.mentions.length, 1);
    await alice.api("POST", `/api/team/channels/${general.id}/messages`, { text: "reply", parentId: sent.message.id });
    await bob.api("POST", `/api/team/messages/${sent.message.id}/reactions`, { emoji: "🎉" });
    const thread = await bob.api("GET", `/api/team/messages/${sent.message.id}/thread`);
    assert.equal(thread.replies.length, 1);
    assert.equal(thread.parent.reactions[0].emoji, "🎉");

    const file = await alice.api("POST", `/api/team/channels/${general.id}/files`, { name: "notes.txt", mime: "text/plain", data: Buffer.from("file body").toString("base64") });
    await alice.api("POST", `/api/team/channels/${general.id}/messages`, { text: "see file", fileIds: [file.id] });
    const download = await bob.raw(`/api/team/files/${file.id}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /attachment/);
    assert.equal(await download.text(), "file body");

    const found = await bob.api("GET", `/api/team/workspaces/${ws.id}/search?q=${encodeURIComponent(phrase)}`);
    assert.equal(found.messages.length, 1);
    const help = await bob.api("POST", `/api/team/channels/${general.id}/messages`, { text: "/help" });
    assert.match(help.ephemeral, /remind/);

    const forged = await fetch(`${origin}/api/team/workspaces`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
    assert.equal(forged.status, 401);

    await new Promise((r) => setTimeout(r, 200));
    const stream = seen.join("");
    assert.match(stream, /"type":"message"/);
    assert.match(stream, /"type":"reaction"/);
    assert.equal(stream.includes(phrase), false, "live events carry ids, not text");
    await reader.cancel();
    await pump;

    if (!child) throw new Error("server missing");
    await stop(child);
    child = undefined;
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = join(dir, "fabric.sqlite") + suffix;
      if (existsSync(f)) assert.equal(readFileSync(f).includes(phrase), false, suffix || "db");
    }
  } finally {
    if (child) await stop(child);
    await idp.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if ((key.startsWith("FABRIC_") || key === "CUMULUS_ID_HOST" || key === "CUMULUS_KEYCLOAK_REALM") && !(key in extra)) delete env[key];
  }
  return env;
}

function startServer(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(appRoot, "src", "server.ts")], {
      cwd: appRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`server did not listen\n${out}\n${err}`));
    }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (!settled && /FABRIC\+\+ listening on http:\/\/\S+/.test(out)) {
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
