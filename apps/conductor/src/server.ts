/**
 * Conductor server: serves the Podium UI and /api/perform.
 * Records evidence on Firmament.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Ledger, MemoryStore } from "@infinitum/firmament";
import { perform } from "./executor.ts";
import { recordEvidence } from "./firmament.ts";
import { podiumHtml } from "./podium.ts";
import { registerDefaultInstruments } from "./instruments.ts";
import type { Score, Autonomy } from "./score.ts";
import { config, log } from "./config.ts";

const { port: PORT } = config;
const ledger = new Ledger(new MemoryStore());

registerDefaultInstruments();

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : {};
}

/** Very simple intent → Score planner (scaffold). */
function plan(intent: string, autonomy: Autonomy = "rehearsal"): Score {
  return {
    id: `score_${Date.now()}`,
    title: intent.slice(0, 60),
    intent,
    autonomy,
    steps: [
      {
        id: "s1",
        description: `Research: ${intent}`,
        instrument: "research",
        input: { query: intent },
        permissions: [{ resource: "web", actions: ["read"] }],
      },
    ],
    success: "research completed",
    createdAt: new Date().toISOString(),
  };
}

const server = createServer(async (req, res) => {
  const start = Date.now();
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    if (url.pathname === "/health") {
      return json(res, 200, { ok: true, service: "conductor", uptime: process.uptime() });
    }
    if (url.pathname === "/api/status") {
      return json(res, 200, { service: "conductor", ledgerEntries: (await ledger.entries()).length, autonomyLevels: ["rehearsal", "accompaniment", "autopilot"] });
    }
    if (url.pathname === "/" ) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(podiumHtml);
    }
    if (url.pathname === "/api/perform" && req.method === "POST") {
      const body = await readBody(req);
      const autonomy = (body.autonomy as Autonomy) ?? "rehearsal";
      const score = plan(String(body.intent ?? ""), autonomy);
      const granted = new Set(["web:read"]);
      const allowed = new Set<Autonomy>(body.allowedAutonomy ?? ["rehearsal", "accompaniment", "autopilot"]);
      const performance = await perform(score, granted, allowed);
      const evidenceEntry = await recordEvidence(ledger, performance);
      return json(res, 200, { score, performance, evidenceHash: evidenceEntry.hash });
    }
    json(res, 404, { error: "not found" });
  } catch (err: any) {
    log("error", "request failed", { path: url.pathname, error: err.message ?? String(err) });
    json(res, 400, { error: err.message ?? String(err) });
  } finally {
    log("info", "request", { method: req.method, path: url.pathname, ms: Date.now() - start });
  }
});

server.listen(PORT, () => {
  log("info", `/CNDCTR/ listening on http://localhost:${PORT}`);
});
