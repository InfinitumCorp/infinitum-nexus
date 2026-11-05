/**
 * Minimal Conductor Podium: a single HTML page that lets a user
 * submit a Score intent and see the performance result.
 * In production this would be a real UI; this is a self-contained scaffold.
 *
 * Brand: packages/brand/brand.css is inlined, so the page uses the same
 * Helvetica Neue type, white palette and /CNDCTR/™ wordmark as infinitum-corporation.vercel.app.
 */

import { readFileSync } from "node:fs";

const brandCss = readFileSync(new URL("../../../packages/brand/brand.css", import.meta.url), "utf8");

export const podiumHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>/CNDCTR/™ Podium</title>
  <style>
${brandCss}
    main { max-width: 720px; margin: 0 auto; padding: 64px 24px; }
    .wordmark { margin: 0; font-size: 34px; }
    p { color: var(--muted); }
    textarea { width: 100%; height: 8rem; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); outline: none; resize: vertical; }
    textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(36,84,221,.12); }
    .btn { display: inline-flex; align-items: center; height: 40px; padding: 0 18px; margin-top: 12px; border-radius: 999px; border: 1px solid var(--line); background: var(--paper); color: var(--ink); text-decoration: none; cursor: pointer; font-weight: 500; }
    .btn.primary { background: var(--ink); border-color: var(--ink); color: var(--paper); }
    #social { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0; }
    #social .btn { margin-top: 0; }
    pre { background: #f7f8f9; border-radius: 12px; padding: 16px; overflow: auto; font-size: 13px; }
    pre:empty { display: none; }
  </style>
</head>
<body>
  <main>
  <h1 class="wordmark">/CNDCTR/<sup class="tm">™</sup></h1>
  <div id="social"></div>
  <p>Write a Score intent (plain text). The executor will plan and simulate.</p>
  <textarea id="intent" placeholder="Research the top 3 competitors of Acme and summarize"></textarea><br>
  <button class="btn primary" id="run">Perform</button>
  <pre id="out"></pre>
  </main>
  <script>

    // Social sign-in (shared Cumulus://ID™). Buttons appear when providers are configured on the CID origin.
    const CID_ORIGIN = window.CID_ORIGIN || "http://localhost:3000";
    fetch(CID_ORIGIN + "/api/auth/providers").then(r => r.json()).then(providers => {
      const el = document.getElementById("social");
      if (!providers.length) return;
      el.innerHTML = providers.map(p =>
        \`<a class="btn" href="\${CID_ORIGIN}/api/auth/oauth/\${p.id}/start">Continue with \${p.label}</a>\`
      ).join("");
    }).catch(() => {});

    document.getElementById("run").onclick = async () => {
      const intent = document.getElementById("intent").value;
      const r = await fetch("/api/perform", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent })
      });
      document.getElementById("out").textContent = JSON.stringify(await r.json(), null, 2);
    };
  </script>
</body>
</html>`;
