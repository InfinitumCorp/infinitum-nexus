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
import type { Score } from "./score.ts";

const PORT = Number(process.env.PORT ?? 3001);
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
function plan(intent: string): Score {
  return {
    id: `score_${Date.now()}`,
    intent,
    autonomy: "rehearsal",
    steps: [
      {
        id: "s1",
        instrument: "research",
        input: { query: intent },
        permissions: [{ resource: "web", actions: ["read"] }],
      },
    ],
    checkpoints: [],
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    if (url.pathname === "/" ) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(podiumHtml);
    }
    if (url.pathname === "/api/perform" && req.method === "POST") {
      const body = await readBody(req);
      const score = plan(String(body.intent ?? ""));
      const granted = new Set(["web:read"]);
      const performance = await perform(score, granted);
      const evidenceEntry = await recordEvidence(ledger, performance);
      return json(res, 200, { score, performance, evidenceHash: evidenceEntry.hash });
    }
    json(res, 404, { error: "not found" });
  } catch (err: any) {
    json(res, 400, { error: err.message ?? String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`/CNDCTR/ listening on http://localhost:${PORT}`);
});
