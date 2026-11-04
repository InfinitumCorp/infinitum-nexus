/**
 * +SPCTR minimal web server.
 * Clean, minimal, white UI foundation. Serves a single-page app
 * and JSON API over the existing core CRM + intelligence modules.
 *
 * Run: node src/server/main.ts   (from apps/spectre)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);

// In-memory store for the scaffold (replace with Firmament-backed store later).
const store = {
  companies: [] as any[],
  contacts: [] as any[],
  deals: [] as any[],
  activities: [] as any[],
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, body: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
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
    input, select, button { font: inherit; padding: 0.5rem 0.75rem; border: 1px solid var(--line); border-radius: 6px; }
    button { background: var(--accent); color: #fff; border: none; cursor: pointer; }
    button.secondary { background: #fff; color: var(--fg); border: 1px solid var(--line); }
    .row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
    .muted { color: var(--muted); font-size: 0.85rem; }
  </style>
</head>
<body>
  <header><h1>+SPCTR</h1></header>
  <main>
    <div class="card">
      <h2 style="margin-top:0">New company</h2>
      <div class="row">
        <div><label>Name</label><input id="name" /></div>
        <div><label>Domain</label><input id="domain" /></div>
        <div><label>&nbsp;</label><button id="add">Add</button></div>
      </div>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Companies</h2>
      <div id="list" class="muted">Loading…</div>
    </div>
  </main>
  <script>
    async function load() {
      const r = await fetch("/api/companies");
      const data = await r.json();
      document.getElementById("list").innerHTML = data.length
        ? data.map(c => `<div>${c.name}${c.domain ? " · " + c.domain : ""}</div>`).join("")
        : "No companies yet.";
    }
    document.getElementById("add").onclick = async () => {
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
    load();
  </script>
</body>
</html>`;

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/" || url.pathname === "/index.html") {
    return html(res, indexHtml);
  }
  if (url.pathname === "/api/companies" && req.method === "GET") {
    return json(res, 200, store.companies);
  }
  if (url.pathname === "/api/companies" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const company = {
      id: crypto.randomUUID(),
      workspace: "demo",
      name: String(body.name ?? "Untitled"),
      domain: body.domain,
      kind: "company",
      facts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.companies.push(company);
    return json(res, 201, company);
  }
  json(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`+SPCTR listening on http://localhost:${PORT}`);
});
