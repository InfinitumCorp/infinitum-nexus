/**
 * Minimal Architect Podium: a single HTML page that lets a user
 * submit a Score intent and see the performance result.
 * In production this would be a real UI; this is a self-contained scaffold.
 * Uses the shared app shell (packages/ui/app-shell.css): Helvetica Neue,
 * white palette, and the :\ARCHITECT\™ wordmark.
 */
/** The shared app shell stylesheet, served at /app-shell.css. */
export { appShellCss } from "./app-shell-css.ts";

export const podiumHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>:\\ARCHITECT\\™ Podium</title>
  <link rel="stylesheet" href="/app-shell.css" />
  <style>
    #intent { min-height: 8rem; }
    #out { margin: 24px 0 0; padding: 16px; border: 1px solid var(--line); white-space: pre-wrap; overflow-x: auto; font-size: var(--text-sm); }
    #out:empty { display: none; }
  </style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="app-bar">
    <a class="app-wordmark" href="/">:\\ARCHITECT\\<sup class="tm">™</sup></a>
    <nav class="app-nav" aria-label="Main">
      <a href="/" aria-current="page">Podium</a>
    </nav>
    <div class="app-actions"><div data-cumulus-bar></div></div>
  </header>
  <main id="main" class="app-main">
    <div class="app-head">
      <div>
        <h1>Podium</h1>
        <p>Write a Score intent in plain text. The executor will plan and simulate.</p>
      </div>
    </div>
    <label class="field" for="intent"><span>Score intent</span>
      <textarea id="intent" class="input" placeholder="Research the top 3 competitors of Acme and summarize"></textarea>
    </label>
    <button id="run" class="btn primary" type="button">Perform</button>
    <pre id="out"></pre>
  </main>
  <script src="https://id.cumuluscloud.app/id/bar.js" data-client="architect" defer></script>
  <script>
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
