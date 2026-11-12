/**
 * Minimal Architect web app: a single HTML page that lets a user
 * submit a Score intent and see the performance result.
 * In production this would be a real UI; this is a self-contained scaffold.
 * Uses the shared app shell (packages/ui/app-shell.css): Helvetica Neue,
 * white palette, and the :\ARCHITECT\™ wordmark.
 */
/** The shared app shell stylesheet, served at /app-shell.css. */
export { appShellCss } from "./app-shell-css.ts";

export const webHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>:\\ARCHITECT\\™</title>
  <link rel="stylesheet" href="/app-shell.css" />
  <style>
    #intent { min-height: 8rem; }
    #out { margin: 24px 0 0; padding: 16px; border: 1px solid var(--line); white-space: pre-wrap; overflow-x: auto; font-size: var(--text-sm); }
    #out:empty { display: none; }
    #social:empty { display: none; }
    #social { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 24px; }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="app-bar">
    <a class="app-wordmark" href="/">:\\ARCHITECT\\<sup class="tm">™</sup></a>
    <nav class="app-nav" aria-label="Main">
      <a href="/" aria-current="page">Home</a>
    </nav>
  </header>
  <main id="main" class="app-main">
    <div class="app-head">
      <div>
        <h1>:\\ARCHITECT\\</h1>
        <p>Write a Score intent in plain text. The executor will plan and simulate.</p>
      </div>
    </div>
    <div id="social"></div>
    <label class="field" for="intent"><span>Score intent</span>
      <textarea id="intent" class="input" placeholder="Research the top 3 competitors of Acme and summarize"></textarea>
    </label>
    <button id="run" class="btn primary" type="button">Perform</button>
    <pre id="out"></pre>
  </main>
  <script>
    // Social sign-in (shared Cumulus://ID™). Buttons appear when providers are configured on the CID origin.
    const CID_ORIGIN = window.CID_ORIGIN || "http://localhost:3000";
    fetch(CID_ORIGIN + "/api/auth/providers").then(r => r.json()).then(providers => {
      const el = document.getElementById("social");
      if (!providers.length) return;
      el.innerHTML = "<strong>Sign in:</strong>" + providers.map(p =>
        \`<a class="btn small" href="\${CID_ORIGIN}/api/auth/oauth/\${p.id}/start">Continue with \${p.label}</a>\`
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
