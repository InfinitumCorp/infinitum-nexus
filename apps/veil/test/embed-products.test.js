/**
 * Embedded paths only. SCALVS.ai is a signed-in tab open. CNDCTR is the Ask
 * POST the sidebar sends. Neither test calls packages/scalus on its own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { submitAsk } from "../lib/ask.js";
import { EXTENSION_FILES } from "../scripts/package.js";
import { fakeChrome } from "./fake-chrome.js";

test("the extension package does not contain the Scalus runtime", () => {
  assert.equal(EXTENSION_FILES.some((file) => file.includes("scalus")), false);
});

test("VEIL opens SCALVS.ai only after sign-in, and drops credentials in a stored origin", async () => {
  const env = fakeChrome();
  globalThis.chrome = env.chrome;
  const fromSidebar = (msg) => env.send(msg, { id: "veilid", url: "chrome-extension://veilid/sidebar.html" });
  const fromPage = (msg) => env.send(msg, { id: "veilid", url: "https://example.com/", tab: { id: 1, windowId: 1, active: true } });
  await import("../background.js");
  await env.listeners.installed[0]();

  assert.match((await fromSidebar({ type: "openApp", id: "scalvs" })).error, /anonymous/);
  assert.match((await fromPage({ type: "openApp", id: "scalvs" })).error, /not allowed/);
  assert.equal(env.calls.tabsCreated.length, 0);

  await fromSidebar({ type: "switchWorkspace", to: "authenticated", confirmed: true });
  env.store.origins = { scalvs: "https://user:secret@scalvs.app/agents" };
  const opened = await fromSidebar({ type: "openApp", id: "scalvs" });
  assert.equal(opened.opened, "https://scalvs.app");
  assert.deepEqual(env.calls.tabsCreated, ["https://scalvs.app"]);
});

test("VEIL Ask posts a rehearsal to the CNDCTR server and omits credentials", async () => {
  const server = fileURLToPath(new URL("../../architect/src/server.ts", import.meta.url));
  const port = 18771;
  const child = spawn(process.execPath, ["--experimental-strip-types", server], {
    env: { ...process.env, PORT: String(port), ARCHITECT_RESEARCH_FIXTURE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  const take = (chunk) => { logs += chunk; };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`architect did not listen\n${logs}`)), 8000);
      const ready = (chunk) => {
        take(chunk);
        if (!logs.includes("listening")) return;
        clearTimeout(timer);
        resolve();
      };
      child.stdout.removeListener("data", take);
      child.stderr.removeListener("data", take);
      child.stdout.on("data", ready);
      child.stderr.on("data", ready);
      if (logs.includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`architect exited ${code}\n${logs}`));
      });
    });
    const calls = [];
    const result = await submitAsk({
      origin: `http://127.0.0.1:${port}/not-part-of-the-origin`,
      text: "Summarize the launch",
      page: { title: "Pricing", url: "https://example.com/pricing" },
      dev: true,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return fetch(url, init);
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `http://127.0.0.1:${port}/api/perform`);
    assert.equal(calls[0].init.credentials, "omit");
    assert.equal(calls[0].init.redirect, "error");
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.autonomy, "rehearsal");
    assert.match(sent.intent, /https:\/\/example\.com\/pricing/);
    assert.equal(result.score.autonomy, "rehearsal");
    assert.equal(result.performance.verified, true);
    assert.equal(typeof result.evidenceHash, "string");
    assert.ok(result.evidenceHash.length > 0);
    let pinned = "";
    await submitAsk({
      origin: "javascript:alert(1)",
      text: "no",
      fetchImpl: async (url) => {
        pinned = url;
        return { ok: true, json: async () => ({}) };
      },
    });
    assert.equal(pinned, "https://rchtch.app/api/perform");
  } finally {
    child.kill();
  }
});
