/**
 * +SPCTR web server.
 * Clean, minimal, white UI + JSON API over the real SpectreCRM,
 * Firmament audit trail, and intelligence (scoring / next-best-action).
 *
 * Run: node src/server/main.ts   (from apps/spectre)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Ledger, MemoryStore, generateSigner } from "@infinitum/firmament";
import { SpectreCRM } from "../core/crm.ts";
import { scoreDeal, nextBestAction, riskAlerts, forecast } from "../core/intelligence.ts";
import { researchCompany } from "./research.ts";
import { handleQuery } from "./query.ts";
import { listPendingActions, runPendingActions } from "./execution.ts";
import { buildMap } from "./relationships.ts";
import { listDuplicates, runMerge } from "./cleaning.ts";
import { listCommitteeGaps } from "./committee.ts";

const PORT = Number(process.env.PORT ?? 3000);
const WORKSPACE = "demo";
const ACTOR = "cid:demo-user";

const ledger = new Ledger(new MemoryStore());
const signer = generateSigner();
const crm = new SpectreCRM({ ledger, signer });

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, body: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : {};
}

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>+SPCTR — Spectre</title>
  <style>
    :root { --bg: #fff; --fg: #111; --muted: #666; --line: #e5e5e5; --accent: #000; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); }
    header { padding: 1.5rem 2rem; border-bottom: 1px solid var(--line); }
    h1 { margin: 0; font-size: 1.25rem; font-weight: 500; letter-spacing: 0.02em; }
    main { max-width: 960px; margin: 2rem auto; padding: 0 1.5rem; }
    .card { border: 1px solid var(--line); border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }
    label { display: block; font-size: 0.8rem; color: var(--muted); margin-bottom: 0.25rem; }
    input, select, button, textarea { font: inherit; padding: 0.5rem 0.75rem; border: 1px solid var(--line); border-radius: 6px; }
    button { background: var(--accent); color: #fff; border: none; cursor: pointer; }
    .row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
    .muted { color: var(--muted); font-size: 0.85rem; }
    .deal { padding: 0.5rem 0; border-bottom: 1px solid var(--line); }
    .prob { font-weight: 600; }
    .ledger-entry { padding: 0.4rem 0; border-bottom: 1px solid var(--line); font-size: 0.85rem; }
    .rel { padding: 0.35rem 0; border-bottom: 1px solid var(--line); font-size: 0.9rem; }
  </style>
</head>
<body>
  <header><h1>+SPCTR</h1></header>
  <main>
    <div class="card">
      <h2 style="margin-top:0">Ask Spectre</h2>
      <div class="row">
        <textarea id="query" placeholder="Research Acme, or ask about next steps..." style="flex:1; min-height:4rem"></textarea>
        <button id="ask">Ask</button>
      </div>
      <pre id="queryOut" class="muted"></pre>
    </div>
    <div class="card">
      <h2 style="margin-top:0">New company</h2>
      <div class="row">
        <div><label>Name</label><input id="name" /></div>
        <div><label>Domain</label><input id="domain" /></div>
        <div><label>&nbsp;</label><button id="addCo">Add</button></div>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">New deal</h2>
      <div class="row">
        <div><label>Company ID</label><input id="coId" placeholder="co_..." /></div>
        <div><label>Name</label><input id="dealName" /></div>
        <div><label>Amount</label><input id="amount" type="number" value="10000" /></div>
        <div><label>Close date</label><input id="close" type="date" /></div>
        <div><label>&nbsp;</label><button id="addDeal">Add deal</button></div>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Research a company</h2>
      <div class="row">
        <div><label>Company name</label><input id="researchName" /></div>
        <div><label>&nbsp;</label><button id="researchBtn">Research</button></div>
      </div>
      <pre id="researchOut" class="muted"></pre>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Companies</h2>
      <div id="companies" class="muted">Loading…</div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Pipeline</h2>
      <div id="pipeline" class="muted">Loading…</div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Relationship map</h2>
      <div class="muted" style="margin-bottom:0.5rem">Who knows whom (strength 1–5).</div>
      <div class="row">
        <div><label>From (contact id or cid:...)</label><input id="relFrom" /></div>
        <div><label>To</label><input id="relTo" /></div>
        <div><label>Strength</label><input id="relStr" type="number" min="1" max="5" value="3" /></div>
        <div><label>Note</label><input id="relNote" /></div>
        <div><label>&nbsp;</label><button id="addRel">Add edge</button></div>
      </div>
      <div id="relmap" class="muted">Loading…</div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Buying-committee gaps</h2>
      <div class="muted" style="margin-bottom:0.5rem">Missing decision-maker, champion, or influencer on open deals.</div>
      <div id="committee" class="muted">Loading…</div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Self-cleaning</h2>
      <div class="muted" style="margin-bottom:0.5rem">Duplicate companies/contacts and data issues.</div>
      <div id="cleaning" class="muted">Loading…</div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Self-executing actions</h2>
      <div class="muted" style="margin-bottom:0.5rem">Rules that match open deals. Review before running in production.</div>
      <div id="actions" class="muted">Loading…</div>
      <button id="runActions" style="margin-top:0.5rem">Run via Conductor</button>
      <pre id="runOut" class="muted"></pre>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Shared Truth Ledger</h2>
      <div class="muted" style="margin-bottom:0.5rem">Every create, update, and fact recorded on Firmament.</div>
      <div id="ledger" class="muted">Loading…</div>
    </div>
  </main>
  <script>
    async function load() {
      const [cos, deals, ledger, actions, rel, clean, committee] = await Promise.all([
        fetch("/api/companies").then(r => r.json()),
        fetch("/api/deals").then(r => r.json()),
        fetch("/api/ledger").then(r => r.json()),
        fetch("/api/execution").then(r => r.json()),
        fetch("/api/relationships").then(r => r.json()),
        fetch("/api/cleaning").then(r => r.json()),
        fetch("/api/committee").then(r => r.json())
      ]);
      document.getElementById("companies").innerHTML = cos.length
        ? cos.map(c => `<div>${c.id} — ${c.name}${c.domain ? " · " + c.domain : ""}</div>`).join("")
        : "No companies yet.";
      document.getElementById("pipeline").innerHTML = deals.length
        ? deals.map(d => `<div class="deal"><strong>${d.name}</strong> (${d.stage}) — $${d.amount}<br><span class="prob">${Math.round(d.score.probability * 100)}% win</span> · ${d.next.action}<br><span class="muted">${d.next.why}</span></div>`).join("")
        : "No deals yet.";
      document.getElementById("actions").innerHTML = actions.length
        ? actions.map(a => `<div class="deal"><strong>${a.type}</strong> · ${a.dealId}<br>${a.description}<br><span class="muted">${JSON.stringify(a.payload)}</span></div>`).join("")
        : "No pending actions.";
      document.getElementById("relmap").innerHTML = rel.edges.length
        ? rel.edges.map(e => {
            const from = rel.nodes.find(n => n.id === e.from);
            const to = rel.nodes.find(n => n.id === e.to);
            return `<div class="rel">${from?.label ?? e.from} —${e.strength}→ ${to?.label ?? e.to}${e.note ? " · " + e.note : ""}</div>`;
          }).join("")
        : "No relationships yet.";
      document.getElementById("committee").innerHTML = committee.length
        ? committee.map(g => `<div class="deal"><strong>${g.dealName}</strong><br>${g.message}<br><span class="muted">Present: ${g.present.join(", ") || "none"}</span></div>`).join("")
        : "No committee gaps.";
      const cleanHtml = [
        ...clean.companies.map(g => `<div class="deal"><strong>Company dup</strong> · ${g.reason}<br>Keep ${g.keep.name} (${g.keep.id}) — merge ${g.duplicates.map(d => d.name).join(", ")}</div>`),
        ...clean.contacts.map(g => `<div class="deal"><strong>Contact dup</strong> · ${g.reason}<br>Keep ${g.keep.name} (${g.keep.id}) — merge ${g.duplicates.map(d => d.name).join(", ")}</div>`),
        ...clean.issues.map(i => `<div class="deal"><strong>${i.kind}</strong> · ${i.message}</div>`)
      ].join("");
      document.getElementById("cleaning").innerHTML = cleanHtml || "No duplicates or issues.";
      document.getElementById("ledger").innerHTML = ledger.length
        ? ledger.map(e => `<div class="ledger-entry"><strong>${e.type}</strong> · ${e.subject}<br><span class="muted">${e.timestamp} · ${e.actor}</span><br>${JSON.stringify(e.payload)}</div>`).join("")
        : "No ledger entries yet.";
    }
    document.getElementById("addCo").onclick = async () => {
      const name = document.getElementById("name").value.trim();
      if (!name) return;
      await fetch("/api/companies", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, domain: document.getElementById("domain").value.trim() || undefined })
      });
      document.getElementById("name").value = "";
      document.getElementById("domain").value = "";
      load();
    };
    document.getElementById("addDeal").onclick = async () => {
      const companyId = document.getElementById("coId").value.trim();
      const name = document.getElementById("dealName").value.trim();
      const amount = Number(document.getElementById("amount").value);
      const closeDate = document.getElementById("close").value;
      if (!companyId || !name || !closeDate) return;
      await fetch("/api/deals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyId, name, amount, closeDate })
      });
      document.getElementById("dealName").value = "";
      load();
    };
    document.getElementById("addRel").onclick = async () => {
      const from = document.getElementById("relFrom").value.trim();
      const to = document.getElementById("relTo").value.trim();
      const strength = Number(document.getElementById("relStr").value);
      const note = document.getElementById("relNote").value.trim() || undefined;
      if (!from || !to) return;
      await fetch("/api/relationships", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from, to, strength, note })
      });
      document.getElementById("relFrom").value = "";
      document.getElementById("relTo").value = "";
      document.getElementById("relNote").value = "";
      load();
    };
    document.getElementById("researchBtn").onclick = async () => {
      const name = document.getElementById("researchName").value.trim();
      if (!name) return;
      const r = await fetch("/api/research?name=" + encodeURIComponent(name));
      const data = await r.json();
      document.getElementById("researchOut").textContent = JSON.stringify(data, null, 2);
    };
    document.getElementById("ask").onclick = async () => {
      const text = document.getElementById("query").value.trim();
      if (!text) return;
      const r = await fetch("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text })
      });
      document.getElementById("queryOut").textContent = JSON.stringify(await r.json(), null, 2);
    };
    document.getElementById("runActions").onclick = async () => {
      const r = await fetch("/api/execution", { method: "POST" });
      const data = await r.json();
      document.getElementById("runOut").textContent = JSON.stringify(data, null, 2);
      load();
    };
    load();
  </script>
</body>
</html>`;

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return html(res, indexHtml);
    }

    if (url.pathname === "/api/companies" && req.method === "GET") {
      return json(res, 200, crm.list("companies", WORKSPACE));
    }
    if (url.pathname === "/api/companies" && req.method === "POST") {
      const body = await readBody(req);
      const c = await crm.addCompany(WORKSPACE, ACTOR, { name: String(body.name ?? ""), domain: body.domain });
      return json(res, 201, c);
    }

    if (url.pathname === "/api/deals" && req.method === "GET") {
      const deals = crm.list("deals", WORKSPACE);
      const activities = crm.list("activities", WORKSPACE);
      const now = crm.now();
      const enriched = deals.map((d) => {
        const score = scoreDeal(d, activities, now);
        const next = nextBestAction(d, score, activities, now);
        return { ...d, score, next };
      });
      return json(res, 200, enriched);
    }
    if (url.pathname === "/api/deals" && req.method === "POST") {
      const body = await readBody(req);
      const d = await crm.addDeal(WORKSPACE, ACTOR, {
        companyId: String(body.companyId ?? ""),
        name: String(body.name ?? ""),
        amount: Number(body.amount ?? 0),
        closeDate: String(body.closeDate ?? ""),
      });
      return json(res, 201, d);
    }

    if (url.pathname === "/api/relationships" && req.method === "GET") {
      return json(res, 200, buildMap(crm, WORKSPACE));
    }
    if (url.pathname === "/api/relationships" && req.method === "POST") {
      const body = await readBody(req);
      const r = await crm.relate(
        WORKSPACE,
        ACTOR,
        String(body.from ?? ""),
        String(body.to ?? ""),
        Number(body.strength ?? 3) as 1 | 2 | 3 | 4 | 5,
        body.note ? String(body.note) : undefined,
      );
      return json(res, 201, r);
    }

    if (url.pathname === "/api/committee" && req.method === "GET") {
      return json(res, 200, listCommitteeGaps(crm, WORKSPACE));
    }

    if (url.pathname === "/api/cleaning" && req.method === "GET") {
      return json(res, 200, listDuplicates(crm, WORKSPACE));
    }
    if (url.pathname === "/api/cleaning" && req.method === "POST") {
      const body = await readBody(req);
      const result = await runMerge(
        crm,
        WORKSPACE,
        ACTOR,
        body.kind,
        String(body.keepId ?? ""),
        Array.isArray(body.mergeIds) ? body.mergeIds.map(String) : [],
      );
      return json(res, 200, result);
    }

    if (url.pathname === "/api/research" && req.method === "GET") {
      const name = url.searchParams.get("name") ?? "";
      if (!name) return json(res, 400, { error: "name required" });
      const result = await researchCompany(name);
      return json(res, 200, result);
    }

    if (url.pathname === "/api/query" && req.method === "POST") {
      const body = await readBody(req);
      const result = await handleQuery(String(body.text ?? ""), { crm, workspace: WORKSPACE, ledger });
      return json(res, 200, result);
    }

    if (url.pathname === "/api/execution" && req.method === "GET") {
      const actions = await listPendingActions(crm, WORKSPACE);
      return json(res, 200, actions);
    }
    if (url.pathname === "/api/execution" && req.method === "POST") {
      const result = await runPendingActions(crm, WORKSPACE);
      return json(res, 200, result);
    }

    if (url.pathname === "/api/ledger" && req.method === "GET") {
      const entries = await ledger.entries();
      const spectre = entries.filter((e) => e.product === "spectre");
      return json(res, 200, spectre.slice(-50).reverse());
    }

    if (url.pathname === "/api/alerts" && req.method === "GET") {
      const deals = crm.list("deals", WORKSPACE);
      const activities = crm.list("activities", WORKSPACE);
      const now = crm.now();
      const scores = new Map(deals.map((d) => [d.id, scoreDeal(d, activities, now)]));
      return json(res, 200, riskAlerts(deals, scores));
    }

    if (url.pathname === "/api/forecast" && req.method === "GET") {
      const deals = crm.list("deals", WORKSPACE);
      const activities = crm.list("activities", WORKSPACE);
      const now = crm.now();
      const scores = new Map(deals.map((d) => [d.id, scoreDeal(d, activities, now)]));
      return json(res, 200, forecast(deals, scores, 3, now));
    }

    json(res, 404, { error: "not found" });
  } catch (err: any) {
    json(res, 400, { error: err.message ?? String(err), code: err.code });
  }
});

server.listen(PORT, () => {
  console.log(`+SPCTR listening on http://localhost:${PORT}`);
});
