/**
 * HTTP surface for the SCALVS.ai runtime.
 *
 *   GET  /health
 *   GET  /            the SCALVS app (HTML). JSON index still requires a token.
 *   GET  /app.js
 *   GET  /app.css
 *   GET  /firm-suite.js, /firm-suite.css   (FIRM Suite embed, public)
 *   GET  /v1/agents
 *   POST /v1/agents
 *   GET  /v1/teams
 *   POST /v1/teams
 *   GET  /v1/tools
 *   POST /v1/agents/run
 *   POST /v1/team/run
 *   POST /v1/memory
 *   GET  /v1/memory/:agentId
 *   POST /v1/memory/:agentId/clear
 *   POST /v1/memory/persist
 *   POST /v1/evidence
 *   POST /v1/llm/run
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent, type Agent, type Tool } from "./agent.ts";
import { runAndRecord } from "./architect.ts";
import { createCumulusAuth, isKeysUnavailable, type CumulusAuth } from "./cumulus-auth.ts";
import { sharedRouter } from "@infinitum/ai";
import { LlmError, runLlmAgent, type LlmTool } from "./llm.ts";
import { FirmamentVault } from "./memory-firmament.ts";
import { Team } from "./team.ts";
import { defaultTools } from "./tools.ts";

const BODY_LIMIT = 1_000_000;
const TEXT_LIMIT = 16_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

const toolsByName = new Map(defaultTools.map((tool) => [tool.name, tool]));
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const indexHtml = readFileSync(join(publicDir, "index.html"), "utf8");
const appJs = readFileSync(join(publicDir, "app.js"), "utf8");
const appCss = readFileSync(join(publicDir, "app.css"), "utf8");
const firmSuiteJs = readFileSync(join(publicDir, "firm-suite.js"), "utf8");
const firmSuiteCss = readFileSync(join(publicDir, "firm-suite.css"), "utf8");

interface SavedAgent {
  id: string;
  name: string;
  role: string;
  tools: string[];
}

interface SavedTeam {
  id: string;
  name: string;
  agentIds: string[];
}

export interface ScalvsServerOptions {
  origin: string;
  vault?: FirmamentVault;
  /** Cumulus ID token audience. Default scalvs. */
  audience?: string;
  /** Discovery and JWKS fetch. Tests pass a fake so the issuer is never called. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

class HttpError extends Error {
  readonly status: number;
  readonly headers?: Record<string, string>;
  constructor(status: number, message: string, headers?: Record<string, string>) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function createScalvsServer(options: ScalvsServerOptions) {
  const vault = options.vault ?? new FirmamentVault();
  const origin = options.origin;
  const auth = createCumulusAuth({ audience: options.audience, fetchImpl: options.fetchImpl, now: options.now });
  const agents = new Map<string, SavedAgent>();
  const teams = new Map<string, SavedTeam>();

  return createServer((req, res) => {
    void handle(req, res, { origin, vault, auth, agents, teams }).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, { error: "internal error" }, origin);
      console.error(JSON.stringify({ event: "error", message: err instanceof Error ? err.message : "error" }));
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: {
    origin: string;
    vault: FirmamentVault;
    auth: CumulusAuth;
    agents: Map<string, SavedAgent>;
    teams: Map<string, SavedTeam>;
  },
) {
  const { origin, vault } = deps;
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const publicApp = req.method === "GET" && (
      url.pathname === "/app.js"
      || url.pathname === "/app.css"
      || url.pathname === "/firm-suite.js"
      || url.pathname === "/firm-suite.css"
      || (url.pathname === "/" && wantsHtml(req))
    );
    if (!(req.method === "GET" && url.pathname === "/health") && !publicApp) {
      const authorization = Array.isArray(req.headers.authorization) ? undefined : req.headers.authorization;
      try {
        await deps.auth.authenticate(authorization);
      } catch (err) {
        if (isKeysUnavailable(err)) console.error(JSON.stringify({ event: "auth", message: "signing keys unavailable" }));
        throw new HttpError(401, "unauthorized", { "www-authenticate": `Bearer realm="${deps.auth.audience}"` });
      }
    }

    if (req.method === "OPTIONS") {
      send(res, 204, "", origin, "text/plain; charset=utf-8", {
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
        "access-control-max-age": "600",
      });
      return;
    }

    if (url.pathname === "/health") {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed", { allow: "GET" });
      send(res, 200, { ok: true, service: "scalvs", origin, uptime: process.uptime() }, origin);
      return;
    }

    if (url.pathname === "/") {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed", { allow: "GET" });
      if (wantsHtml(req)) send(res, 200, indexHtml, origin, "text/html; charset=utf-8");
      else send(res, 200, home(origin), origin);
      return;
    }

    if (url.pathname === "/app.js" && req.method === "GET") {
      send(res, 200, appJs, origin, "text/javascript; charset=utf-8");
      return;
    }
    if (url.pathname === "/app.css" && req.method === "GET") {
      send(res, 200, appCss, origin, "text/css; charset=utf-8");
      return;
    }
    if (url.pathname === "/firm-suite.js" && req.method === "GET") {
      send(res, 200, firmSuiteJs, origin, "text/javascript; charset=utf-8");
      return;
    }
    if (url.pathname === "/firm-suite.css" && req.method === "GET") {
      send(res, 200, firmSuiteCss, origin, "text/css; charset=utf-8");
      return;
    }

    if (url.pathname === "/v1/agents" && req.method === "GET") {
      send(res, 200, [...deps.agents.values()], origin);
      return;
    }
    if (url.pathname === "/v1/agents" && req.method === "POST") {
      const body = asRecord(await readJson(req));
      const agent = describeAgent(body);
      if (deps.agents.has(agent.id)) throw new HttpError(409, "agent already exists");
      deps.agents.set(agent.id, agent);
      send(res, 201, agent, origin);
      return;
    }
    if (url.pathname === "/v1/teams" && req.method === "GET") {
      send(res, 200, [...deps.teams.values()], origin);
      return;
    }
    if (url.pathname === "/v1/teams" && req.method === "POST") {
      const body = asRecord(await readJson(req));
      const team = describeTeam(body, deps.agents);
      if (deps.teams.has(team.id)) throw new HttpError(409, "team already exists");
      deps.teams.set(team.id, team);
      send(res, 201, team, origin);
      return;
    }

    if (url.pathname === "/v1/tools") {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed", { allow: "GET" });
      send(res, 200, defaultTools.map((tool) => ({ name: tool.name, description: tool.description })), origin);
      return;
    }

    if (url.pathname === "/v1/agents/run") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed", { allow: "POST" });
      const body = asRecord(await readJson(req));
      send(res, 200, await runAgent(toAgent(body, vault), requireText(body.prompt, "prompt")), origin);
      return;
    }

    if (url.pathname === "/v1/team/run") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed", { allow: "POST" });
      const body = asRecord(await readJson(req));
      const prompt = requireText(body.prompt, "prompt");
      if (!Array.isArray(body.agents) || body.agents.length === 0) throw new HttpError(400, "agents must be a non-empty array");
      if (body.agents.length > 16) throw new HttpError(400, "too many agents");
      const agents = body.agents.map((item) => toAgent(asRecord(item), vault));
      send(res, 200, await new Team(agents).run(prompt), origin);
      return;
    }

    if (url.pathname === "/v1/evidence") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed", { allow: "POST" });
      const body = asRecord(await readJson(req));
      send(res, 200, await runAndRecord(toAgent(body, vault), requireText(body.prompt, "prompt")), origin);
      return;
    }

    if (url.pathname === "/v1/memory" && req.method === "POST") {
      const body = asRecord(await readJson(req));
      send(res, 200, vault.remember(requireId(body.agentId, "agentId"), requireText(body.content, "content"), readTags(body.tags)), origin);
      return;
    }

    if (url.pathname === "/v1/memory/persist" && req.method === "POST") {
      const body = asRecord(await readJson(req));
      const entry = vault.remember(requireId(body.agentId, "agentId"), requireText(body.content, "content"), readTags(body.tags));
      send(res, 200, { entry, ...(await vault.persist(entry)) }, origin);
      return;
    }

    const clearMatch = /^\/v1\/memory\/([^/]+)\/clear$/.exec(url.pathname);
    if (clearMatch) {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed", { allow: "POST" });
      const agentId = decodeId(clearMatch[1]);
      vault.clear(agentId);
      send(res, 200, { cleared: true, agentId }, origin);
      return;
    }

    const memoryMatch = /^\/v1\/memory\/([^/]+)$/.exec(url.pathname);
    if (memoryMatch) {
      if (req.method !== "GET") throw new HttpError(405, "method not allowed", { allow: "GET" });
      const agentId = decodeId(memoryMatch[1]);
      const tag = url.searchParams.get("tag");
      if (tag !== null && (tag.length === 0 || tag.length > 40)) throw new HttpError(400, "tag must be 1-40 characters");
      send(res, 200, vault.recall(agentId, tag ?? undefined), origin);
      return;
    }

    if (url.pathname === "/v1/llm/run") {
      if (req.method !== "POST") throw new HttpError(405, "method not allowed", { allow: "POST" });
      const router = sharedRouter();
      if (!router.connected) throw new HttpError(503, "Set OMNIROUTE_BASE_URL or OMNIROUTE_API_KEY to turn on SCALVS.");
      const body = asRecord(await readJson(req));
      try {
        const result = await runLlmAgent(
          { router, maxSteps: readMaxSteps(body.maxSteps) },
          { system: requireText(body.system, "system"), tools: llmTools(body.tools) },
          requireText(body.prompt, "prompt"),
        );
        send(res, 200, result, origin);
      } catch (err) {
        if (err instanceof LlmError) throw new HttpError(502, "the model request failed");
        throw err;
      }
      return;
    }

    if (req.method !== "GET" && req.method !== "POST") throw new HttpError(405, "method not allowed", { allow: "GET, POST" });
    send(res, 404, { error: "not found" }, origin);
  } catch (err) {
    if (err instanceof HttpError) {
      if (!res.headersSent) send(res, err.status, { error: err.message }, origin, "application/json; charset=utf-8", err.headers);
      return;
    }
    console.error(JSON.stringify({ event: "error", message: err instanceof Error ? err.message : "error" }));
    if (!res.headersSent) send(res, 500, { error: "internal error" }, origin);
  }
}

function home(origin: string) {
  return {
    service: "scalvs",
    name: "SCALVS.ai",
    origin,
    tools: defaultTools.map((tool) => tool.name),
  };
}

function describeAgent(body: Record<string, unknown>): SavedAgent {
  const id = requireId(body.id, "id");
  const tools = selectedTools(body.tools);
  if (tools.length === 0) throw new HttpError(400, "choose at least one tool");
  return {
    id,
    name: body.name === undefined ? id : requireText(body.name, "name"),
    role: body.role === undefined ? "agent" : requireText(body.role, "role"),
    tools: tools.map((tool) => tool.name),
  };
}

function describeTeam(body: Record<string, unknown>, agents: Map<string, SavedAgent>): SavedTeam {
  const id = requireId(body.id, "id");
  if (!Array.isArray(body.agentIds) || body.agentIds.length === 0 || body.agentIds.length > 16) {
    throw new HttpError(400, "agentIds must list 1 to 16 agents");
  }
  const agentIds = body.agentIds.map((agentId) => requireId(agentId, "agentId"));
  for (const agentId of agentIds) {
    if (!agents.has(agentId)) throw new HttpError(400, `unknown agent: ${agentId}`);
  }
  return { id, name: body.name === undefined ? id : requireText(body.name, "name"), agentIds };
}

function wantsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept ?? "";
  return accept.includes("text/html");
}

function toAgent(body: Record<string, unknown>, vault: FirmamentVault): Agent {
  const id = requireId(body.id, "id");
  return {
    id,
    name: body.name === undefined ? id : requireText(body.name, "name"),
    role: body.role === undefined ? "agent" : requireText(body.role, "role"),
    tools: selectedTools(body.tools),
    vault,
  };
}

function selectedTools(value: unknown): Tool[] {
  if (value === undefined) return [...defaultTools];
  if (!Array.isArray(value)) throw new HttpError(400, "tools must be an array of tool names");
  if (value.length > 16) throw new HttpError(400, "too many tools");
  const seen = new Set<string>();
  return value.map((name) => {
    if (typeof name !== "string" || !toolsByName.has(name)) {
      throw new HttpError(400, `unknown tool: ${typeof name === "string" ? name.slice(0, 40) : "invalid"}`);
    }
    if (seen.has(name)) throw new HttpError(400, `duplicate tool: ${name}`);
    seen.add(name);
    return toolsByName.get(name)!;
  });
}

function llmTools(value: unknown): LlmTool[] {
  return selectedTools(value).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: { type: "object", properties: { prompt: { type: "string" } } },
    effect: "read" as const,
    run: (input: Record<string, unknown>) => tool.execute(input),
  }));
}

function readMaxSteps(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 8) {
    throw new HttpError(400, "maxSteps must be an integer from 1 to 8");
  }
  return value;
}

function readTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new HttpError(400, "tags must be an array of up to 8 strings");
  return value.map((tag) => {
    if (typeof tag !== "string" || tag.length === 0 || tag.length > 40) throw new HttpError(400, "each tag must be 1-40 characters");
    return tag;
  });
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new HttpError(400, `${name} is required`);
  if (value.length > TEXT_LIMIT) throw new HttpError(400, `${name} is too long`);
  return value;
}

function requireId(value: unknown, name: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new HttpError(400, `${name} must be 1-64 letters, digits, or . _ : -`);
  }
  return value;
}

function decodeId(raw: string): string {
  try {
    return requireId(decodeURIComponent(raw), "agentId");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "agentId must be 1-64 letters, digits, or . _ : -");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "JSON object required");
  return value as Record<string, unknown>;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers["content-type"];
  if (!contentType || !contentType.includes("application/json")) {
    return Promise.reject(new HttpError(415, "content-type must be application/json"));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = (error: HttpError) => {
      if (failed) return;
      failed = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(new HttpError(413, "body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        fail(new HttpError(400, "JSON object required"));
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        fail(new HttpError(400, "invalid JSON"));
      }
    });
    req.on("error", () => fail(new HttpError(400, "invalid body")));
  });
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  origin: string,
  contentType = "application/json; charset=utf-8",
  extra?: Record<string, string>,
) {
  const payload = contentType.startsWith("application/json") ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "access-control-allow-origin": origin,
    vary: "origin",
    ...extra,
  });
  res.end(payload);
}
