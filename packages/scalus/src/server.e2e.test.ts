/**
 * Starts the SCALVS process and calls its HTTP endpoints.
 * A second case builds dist/ and starts that process the same way.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceArgs = ["--experimental-strip-types", "src/server.ts"];

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0" };
  for (const key of ["SCALVS_ORIGIN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]) delete env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

interface Started {
  child: ChildProcess;
  port: number;
  origin: string;
  base: string;
}

function start(args: string[], overrides?: Record<string, string | undefined>): Promise<Started> {
  const child = spawn(process.execPath, args, {
    cwd: packageRoot,
    env: baseEnv(overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not listen\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 8_000);
    const finish = (error?: Error, started?: Started) => {
      clearTimeout(timer);
      child.stdout!.off("data", onStdout);
      child.off("exit", onExit);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else if (started) resolve(started);
    };
    const onStdout = (chunk: string) => {
      stdout += chunk;
      for (const line of stdout.split("\n")) {
        if (!line.includes("\"event\":\"listening\"")) continue;
        const msg = JSON.parse(line) as { port: number; origin: string };
        finish(undefined, { child, port: msg.port, origin: msg.origin, base: `http://127.0.0.1:${msg.port}` });
        return;
      }
    };
    const onExit = (code: number | null) => {
      finish(new Error(`server exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
    };
    child.stdout!.on("data", onStdout);
    child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    child.on("exit", onExit);
  });
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const killer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  clearTimeout(killer);
  assert.equal(code, 0);
}

async function runToExit(args: string[], overrides: Record<string, string | undefined>) {
  const child = spawn(process.execPath, args, {
    cwd: packageRoot,
    env: baseEnv(overrides),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const [code] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  return { code, stdout, stderr };
}

async function call(base: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const res = await fetch(base + path, {
    method,
    headers: {
      connection: "close",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: res.status, body: parsed as any, headers: res.headers, text };
}

describe("SCALVS runtime over HTTP", { concurrency: false }, () => {
  const origin = "http://localhost:3020";
  let started: Started;

  before(async () => {
    started = await start(sourceArgs, { SCALVS_ORIGIN: origin });
  });

  after(async () => {
    await stop(started?.child);
  });

  it("answers health with the configured origin", async () => {
    const health = await call(started.base, "GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.service, "scalvs");
    assert.equal(health.body.origin, origin);
    assert.equal(typeof health.body.uptime, "number");
    assert.equal(health.headers.get("access-control-allow-origin"), origin);
    assert.notEqual(health.headers.get("access-control-allow-origin"), "*");
    assert.equal(new URL(started.base).port, String(started.port));
  });

  it("serves an HTML page and a JSON index", async () => {
    const page = await call(started.base, "GET", "/", undefined, { accept: "text/html" });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.text, /SCALVS\.ai/);
    assert.match(page.text, /http:\/\/localhost:3020/);

    const index = await call(started.base, "GET", "/");
    assert.equal(index.status, 200);
    assert.equal(index.body.name, "SCALVS.ai");
    assert.deepEqual(index.body.tools, ["echo", "search", "note"]);
  });

  it("lists the built-in tools", async () => {
    const tools = await call(started.base, "GET", "/v1/tools");
    assert.equal(tools.status, 200);
    assert.deepEqual(tools.body.map((tool: { name: string }) => tool.name), ["echo", "search", "note"]);
  });

  it("runs an agent, remembers the run, and clears that memory", async () => {
    const run = await call(started.base, "POST", "/v1/agents/run", {
      id: "researcher",
      name: "Researcher",
      role: "Research",
      prompt: "hello",
      tools: ["echo"],
    });
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.equal(run.body.agentId, "researcher");
    assert.equal(run.body.toolCalls.length, 1);
    assert.equal(run.body.toolCalls[0].tool, "echo");
    assert.deepEqual(run.body.toolCalls[0].result, { echoed: "hello" });
    assert.equal(run.body.memory.length, 1);

    const noted = await call(started.base, "POST", "/v1/agents/run", {
      id: "scribe",
      name: "Scribe",
      role: "Notes",
      prompt: "please note the meeting",
      tools: ["note"],
    });
    assert.equal(noted.status, 200, JSON.stringify(noted.body));
    assert.equal(noted.body.toolCalls[0].tool, "note");
    assert.equal(noted.body.toolCalls[0].result.stored, true);

    const recalled = await call(started.base, "GET", "/v1/memory/researcher");
    assert.equal(recalled.status, 200);
    assert.equal(recalled.body.length, 1);
    assert.match(recalled.body[0].content, /echo:/);

    const cleared = await call(started.base, "POST", "/v1/memory/researcher/clear", {});
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.cleared, true);
    const empty = await call(started.base, "GET", "/v1/memory/researcher");
    assert.deepEqual(empty.body, []);
  });

  it("runs a team and records Architect evidence", async () => {
    const team = await call(started.base, "POST", "/v1/team/run", {
      prompt: "hello",
      agents: [
        { id: "alpha", name: "Alpha", role: "research", tools: ["echo"] },
        { id: "beta", name: "Beta", role: "notes", tools: ["note"] },
      ],
    });
    assert.equal(team.status, 200, JSON.stringify(team.body));
    assert.equal(team.body.length, 2);
    assert.deepEqual(team.body.map((result: { agentId: string }) => result.agentId), ["alpha", "beta"]);

    const evidence = await call(started.base, "POST", "/v1/evidence", {
      id: "recorder",
      name: "Recorder",
      role: "audit",
      prompt: "hello",
      tools: ["echo"],
    });
    assert.equal(evidence.status, 200, JSON.stringify(evidence.body));
    assert.equal(evidence.body.agentId, "recorder");
    assert.equal(evidence.body.verified, true);
    assert.equal(typeof evidence.body.at, "string");
  });

  it("stores a vault note and returns a Firmament hash", async () => {
    const saved = await call(started.base, "POST", "/v1/memory/persist", {
      agentId: "keeper",
      content: "anchored",
      tags: ["firm"],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.entry.content, "anchored");
    assert.match(saved.body.hash, /^0xfirm_/);
    const recalled = await call(started.base, "GET", "/v1/memory/keeper?tag=firm");
    assert.equal(recalled.body.length, 1);
    assert.equal(recalled.body[0].content, "anchored");
  });

  it("rejects unknown routes, bad bodies, and a missing model key", async () => {
    assert.equal((await call(started.base, "GET", "/missing")).status, 404);
    assert.equal((await call(started.base, "POST", "/health", {})).status, 405);
    assert.equal((await call(started.base, "POST", "/health", {})).headers.get("allow"), "GET");

    const bare = await fetch(started.base + "/v1/agents/run", { method: "POST", body: "{}", headers: { connection: "close" } });
    assert.equal(bare.status, 415);

    const invalid = await call(started.base, "POST", "/v1/agents/run", "{");
    assert.equal(invalid.status, 400);

    const missing = await call(started.base, "POST", "/v1/agents/run", { id: "researcher" });
    assert.equal(missing.status, 400);

    const unknown = await call(started.base, "POST", "/v1/agents/run", { id: "researcher", prompt: "hello", tools: ["searcher"] });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /unknown tool/);

    const llm = await call(started.base, "POST", "/v1/llm/run", { system: "You are SCALVS.", prompt: "hello", tools: ["echo"] });
    assert.equal(llm.status, 503);
    assert.match(llm.body.error, /ANTHROPIC_API_KEY/);

    const huge = await call(started.base, "POST", "/v1/agents/run", `{"prompt":"${"a".repeat(1_000_001)}"}`);
    assert.equal(huge.status, 413);
  });

  it("answers a CORS preflight for the configured origin", async () => {
    const preflight = await call(started.base, "OPTIONS", "/v1/agents/run");
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
  });
});

describe("SCALVS process configuration", () => {
  it("defaults the origin to https://scalvs.app", async () => {
    const started = await start(sourceArgs);
    try {
      assert.equal(started.origin, "https://scalvs.app");
      const health = await call(started.base, "GET", "/health");
      assert.equal(health.status, 200);
      assert.equal(health.body.origin, "https://scalvs.app");
      assert.equal(health.headers.get("access-control-allow-origin"), "https://scalvs.app");
    } finally {
      await stop(started.child);
    }
  });

  it("refuses to start with a bad PORT or origin", async () => {
    const badPort = await runToExit(sourceArgs, { PORT: "nope" });
    assert.notEqual(badPort.code, 0);
    assert.match(badPort.stderr, /PORT/);

    const badOrigin = await runToExit(sourceArgs, { SCALVS_ORIGIN: "*" });
    assert.notEqual(badOrigin.code, 0);
    assert.match(badOrigin.stderr, /SCALVS_ORIGIN/);

    const credentials = await runToExit(sourceArgs, { SCALVS_ORIGIN: "https://user:secret@scalvs.app/agents" });
    assert.notEqual(credentials.code, 0);
    assert.match(credentials.stderr, /credentials/);
  });
});

describe("SCALVS production build", () => {
  it("serves health from dist/server.js", async () => {
    const build = spawn(process.execPath, ["--experimental-strip-types", "scripts/build.ts"], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    build.stderr!.setEncoding("utf8");
    build.stderr!.on("data", (chunk: string) => { stderr += chunk; });
    const [code] = (await once(build, "exit")) as [number | null, NodeJS.Signals | null];
    assert.equal(code, 0, stderr);

    const serverJs = readFileSync(join(packageRoot, "dist/server.js"), "utf8");
    assert.match(serverJs, /from\s+["']\.\/http\.js["']/);
    assert.doesNotMatch(serverJs, /from\s+["'][^"']+\.ts["']/);

    const started = await start(["dist/server.js"]);
    try {
      assert.equal(started.origin, "https://scalvs.app");
      const health = await call(started.base, "GET", "/health");
      assert.equal(health.status, 200);
      assert.equal(health.body.ok, true);
      assert.equal(health.body.service, "scalvs");
      assert.equal(health.body.origin, "https://scalvs.app");

      const run = await call(started.base, "POST", "/v1/agents/run", {
        id: "researcher",
        prompt: "hello",
        tools: ["echo"],
      });
      assert.equal(run.status, 200, JSON.stringify(run.body));
      assert.equal(run.body.toolCalls[0].tool, "echo");
    } finally {
      await stop(started.child);
    }
  });
});
