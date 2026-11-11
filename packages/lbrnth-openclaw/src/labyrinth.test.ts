import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { artifactPath, DEFAULT_ENDPOINT, LabyrinthToolError, LabyrinthTools } from "./labyrinth.ts";
import { labyrinthToolDefinitions, TOOL_NAMES } from "./tools.ts";
import { pluginManifest } from "./manifest.ts";

const TOKEN = `lbrnth_${"a".repeat(43)}`;
type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** A fake relay holding one repository, with the server's prefixing and compare-and-swap rules. */
function relay(options: { status?: number } = {}) {
  const calls: Call[] = [];
  const files = new Map<string, string>([["products/openclaw/notes/a.md", "hello"], ["products/architect/secret-plan.md", "x"]]);
  let head: string | null = "c1";
  const fake = async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), init: init!, body });
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (options.status) return reply(options.status, { error: "Cumulus ID session expired or revoked" });
    switch (body.action) {
      case "list": return reply(200, [{ id: "r1", name: "work", visibility: "private", branches: { main: head }, tags: {} }]);
      case "load": return files.has(`products/openclaw/${body.path}`) && body.commit === head ? reply(200, { content: files.get(`products/openclaw/${body.path}`) }) : reply(404, { error: "Path not found" });
      case "save": {
        if (body.expectedHead !== head) return reply(409, { error: "Branch head changed" });
        files.set(`products/openclaw/${body.path}`, String(body.content)); head = `c${Number(head!.slice(1)) + 1}`;
        return reply(200, { id: head });
      }
      case "history": return reply(200, [{ id: head, parent: "c0", message: "m", at: "2026-11-12T00:00:00Z", author: "cid_x", tree: Object.fromEntries([...files.keys()].map(k => [k, "h"])) }]);
      default: return reply(400, { error: "Invalid Labyrinth command" });
    }
  };
  return { calls, fetch: fake as typeof fetch, bump: () => { head = "c9"; } };
}

test("calls the relay as product openclaw with a bearer, never with cookies or redirects", async () => {
  const r = relay();
  const tools = new LabyrinthTools({ token: TOKEN }, { fetch: r.fetch, env: {} });
  assert.deepEqual(await tools.repositories(), [{ id: "r1", name: "work", branches: { main: "c1" } }]);
  const [call] = r.calls;
  assert.equal(call.url, DEFAULT_ENDPOINT);
  assert.equal(call.body.product, "openclaw");
  assert.equal(call.init.redirect, "error");
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["x-labyrinth"], "1");
  assert.equal(call.init.credentials, undefined);
});

test("reads the latest version and saves with compare-and-swap", async () => {
  const r = relay();
  const tools = new LabyrinthTools({ token: TOKEN }, { fetch: r.fetch, env: {} });
  assert.equal((await tools.read("work", "notes/a.md")).content, "hello");
  const saved = await tools.save("work", "notes/a.md", "hello again", "update note");
  assert.deepEqual(saved, { repo: "work", branch: "main", commit: "c2", path: "notes/a.md" });
  const save = r.calls.find(c => c.body.action === "save")!;
  assert.equal(save.body.expectedHead, "c1");
  assert.equal(save.body.repo, "r1");
  assert.equal((await tools.read("r1", "notes/a.md")).content, "hello again");
});

test("a concurrent change is a conflict with a retry hint, not an overwrite", async () => {
  const r = relay();
  const tools = new LabyrinthTools({ token: TOKEN }, { fetch: r.fetch, env: {} });
  const original = r.fetch;
  let first = true;
  const racing = (async (url: string, init: RequestInit) => {
    const response = await original(url, init);
    if (first && JSON.parse(String(init.body)).action === "list") { first = false; r.bump(); }
    return response;
  }) as typeof fetch;
  const raced = new LabyrinthTools({ token: TOKEN }, { fetch: racing, env: {} });
  await assert.rejects(raced.save("work", "notes/a.md", "x"), (e: unknown) => e instanceof LabyrinthToolError && e.status === 409 && /read it again/.test(e.message));
  assert.equal((await tools.repositories())[0].branches.main, "c9");
});

test("history shows only this agent's files", async () => {
  const r = relay();
  const tools = new LabyrinthTools({ token: TOKEN }, { fetch: r.fetch, env: {} });
  const [commit] = await tools.history("work");
  assert.deepEqual(commit.paths, ["notes/a.md"]);
  assert.equal(JSON.stringify(commit).includes("architect"), false);
  assert.equal("author" in commit, false);
});

test("credentials: env fallback, format check, never echoed in errors", async () => {
  assert.throws(() => new LabyrinthTools({}, { env: {} }), /LBRNTH_TOKEN/);
  assert.throws(() => new LabyrinthTools({ token: "cid-session-cookie" }, { env: {} }), /LBRNTH_TOKEN/);
  const r = relay({ status: 401 });
  const tools = new LabyrinthTools({}, { fetch: r.fetch, env: { LBRNTH_TOKEN: TOKEN } });
  await assert.rejects(tools.repositories(), (e: unknown) => e instanceof LabyrinthToolError && e.status === 401 && !e.message.includes(TOKEN) && /new credential/.test(e.message));
});

test("endpoint must be https and paths stay inside the agent folder", () => {
  for (const endpoint of ["http://id.cumuluscloud.app/api/labyrinth", "https://user:pw@x.example/api", "not a url"]) {
    assert.throws(() => new LabyrinthTools({ endpoint, token: TOKEN }, { env: {} }), /https|URL/);
  }
  assert.equal(new LabyrinthTools({ endpoint: "https://ru.id.cumuluscloud.app/api/labyrinth", token: TOKEN }, { env: {} }) instanceof LabyrinthTools, true);
  assert.equal(artifactPath("notes\\day.md"), "notes/day.md");
  for (const bad of ["../x", "/etc/passwd", "a//b", "a/./b", ""]) assert.throws(() => artifactPath(bad), LabyrinthToolError);
});

test("tool set: save is opt-in, reads are not, and the manifest file matches the code", async () => {
  assert.deepEqual(TOOL_NAMES, ["labyrinth_repositories", "labyrinth_read", "labyrinth_history", "labyrinth_save"]);
  const optional = labyrinthToolDefinitions().filter(t => "optional" in t && t.optional).map(t => t.name);
  assert.deepEqual(optional, ["labyrinth_save"]);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const file = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(file, pluginManifest(pkg.version), "openclaw.plugin.json is stale: run node --experimental-strip-types scripts/manifest.ts");
  assert.deepEqual(pkg.openclaw.extensions, ["./dist/index.js"]);
  const r = relay();
  const [list] = labyrinthToolDefinitions(settings => new LabyrinthTools(settings, { fetch: r.fetch, env: {} }));
  assert.equal(((await list.execute({}, { token: TOKEN })) as unknown[]).length, 1);
});
