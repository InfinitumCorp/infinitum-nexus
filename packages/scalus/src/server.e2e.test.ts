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
  for (const key of ["SCALVS_ORIGIN", "SCALVS_AUDIENCE", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL"]) delete env[key];
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

  it("requires a Cumulus ID token on every route except GET /health", async () => {
    for (const [method, path] of [["GET", "/"], ["GET", "/v1/tools"], ["POST", "/v1/agents/run"], ["OPTIONS", "/v1/agents/run"]] as const) {
      const res = await call(started.base, method, path, method === "POST" ? {} : undefined);
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.body.error, "unauthorized");
    }
    const health = await call(started.base, "GET", "/health");
    assert.equal(health.status, 200);
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

    const badAudience = await runToExit(sourceArgs, { SCALVS_AUDIENCE: "*" });
    assert.notEqual(badAudience.code, 0);
    assert.match(badAudience.stderr, /SCALVS_AUDIENCE/);
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
      assert.equal(run.status, 401);
      assert.equal(run.body.error, "unauthorized");
    } finally {
      await stop(started.child);
    }
  });
});
