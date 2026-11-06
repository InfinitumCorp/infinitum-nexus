/**
 * Minimal Architect Podium: a single HTML page that lets a user
 * submit a Score intent and see the performance result.
 * In production this would be a real UI; this is a self-contained scaffold.
 */

export const podiumHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>:\\ARCHITECT\\ Podium</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; }
    textarea { width: 100%; height: 8rem; font-family: inherit; }
    button { padding: 0.5rem 1rem; }
    pre { background: #f5f5f5; padding: 1rem; }
  </style>
</head>
<body>
  <h1>:\\ARCHITECT\\</h1>
  <div id="social" style="margin-bottom:1rem"></div>
  <p>Write a Score intent (plain text). The executor will plan and simulate.</p>
  <textarea id="intent" placeholder="Research the top 3 competitors of Acme and summarize"></textarea><br>
  <button id="run">Perform</button>
  <pre id="out"></pre>
  <script>
    
    // Social sign-in (shared Cumulus://ID). Buttons appear when providers are configured on the CID origin.
    const CID_ORIGIN = window.CID_ORIGIN || "http://localhost:3000";
    fetch(CID_ORIGIN + "/api/auth/providers").then(r => r.json()).then(providers => {
      const el = document.getElementById("social");
      if (!providers.length) return;
      el.innerHTML = "<strong>Sign in:</strong> " + providers.map(p => 
        \`<a class="btn" href="\${CID_ORIGIN}/api/auth/oauth/\${p.id}/start" style="margin-right:0.5rem;padding:0.4rem 0.8rem;border:1px solid #ccc;border-radius:4px;text-decoration:none">Continue with \${p.label}</a>\`
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
