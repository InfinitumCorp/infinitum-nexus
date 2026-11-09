/*
 * "Sign in with Cumulus://ID", a drop-in button for any Infinitum product site.
 *
 *   <div data-cumulus-id></div>
 *   <script src="https://mail.cumuluscloud.app/id/button.js" data-client="scalvs" defer></script>
 *
 * Uses OAuth 2.0 authorization code + PKCE (S256) against mail.cumuluscloud.app. The access token
 * stays in this tab's sessionStorage. Pages can listen for the "cumulus-id" event on window:
 * event.detail is the profile ({ cid, username, email, name }) or null after signing out.
 * window.CumulusID exposes { profile(), token(), signIn(), signOut() }.
 */
(() => {
  const script = document.currentScript;
  const ID = new URL(script?.src || "https://mail.cumuluscloud.app/id/button.js").origin;
  const CLIENT = script?.dataset.client || "infinitum";
  const KEY = `cumulus-id:${CLIENT}`;
  const PENDING = `${KEY}:pending`;

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch { return null; } },
    set(k, v) { try { if (v == null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const here = () => { const u = new URL(location.href); u.hash = ""; u.searchParams.delete("code"); u.searchParams.delete("state"); return u.toString(); };

  async function signIn() {
    const verifier = random(48);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const state = random(16);
    const redirect = here();
    store.set(PENDING, { verifier, state, redirect });
    const u = new URL("/api/id/authorize", ID);
    u.search = new URLSearchParams({ client_id: CLIENT, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state }).toString();
    location.assign(u.toString());
  }

  async function finish() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code"), state = params.get("state");
    const pending = store.get(PENDING);
    if (!code || !state || !pending) return;
    store.set(PENDING, null);
    history.replaceState(null, "", pending.redirect);
    if (state !== pending.state) return fail("That sign-in didn't match. Please try again.");
    try {
      // text/plain keeps this a simple request (no CORS preflight); the server reads it as JSON.
      const res = await fetch(new URL("/api/id/token", ID), { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ code, code_verifier: pending.verifier, client_id: CLIENT }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.access_token) return fail(data.error || "Sign-in failed. Please try again.");
      store.set(KEY, { token: data.access_token, profile: data.profile, until: Date.now() + (data.expires_in || 3600) * 1000 });
    } catch {
      fail("Couldn't reach Cumulus://ID. Check your connection and try again.");
    }
  }

  async function signOut() {
    const saved = store.get(KEY);
    store.set(KEY, null);
    render();
    if (saved?.token) await fetch(new URL("/api/id/signout", ID), { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ access_token: saved.token }) }).catch(() => {});
  }

  const current = () => { const s = store.get(KEY); if (s && s.until > Date.now()) return s; if (s) store.set(KEY, null); return null; };
  let error = "";
  const fail = (m) => { error = m; };

  const CSS = `.cid-wrap{display:inline-flex;align-items:center;gap:10px;font:14px 'Helvetica Neue',Helvetica,Arial,sans-serif;color:inherit}
.cid-btn{display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 16px;border:1px solid currentColor;background:transparent;color:inherit;font:inherit;cursor:pointer;border-radius:0}
.cid-btn:hover,.cid-btn:focus-visible{outline:2px solid #2454dd;outline-offset:2px}
.cid-err{color:#b3261e;font-size:13px}`;

  function button(label, onClick) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "cid-btn"; b.textContent = label; b.addEventListener("click", onClick);
    return b;
  }

  function render() {
    const s = current();
    for (const host of document.querySelectorAll("[data-cumulus-id]")) {
      const wrap = document.createElement("span");
      wrap.className = "cid-wrap";
      if (s) {
        const who = document.createElement("span");
        who.textContent = `Signed in as ${s.profile?.email || s.profile?.username || "you"}`;
        wrap.append(who, button("Sign out", signOut));
      } else {
        wrap.append(button("Sign in with Cumulus://ID", signIn));
        if (error) { const e = document.createElement("span"); e.className = "cid-err"; e.setAttribute("role", "alert"); e.textContent = error; wrap.append(e); }
      }
      host.replaceChildren(wrap);
    }
    window.dispatchEvent(new CustomEvent("cumulus-id", { detail: s ? s.profile : null }));
  }

  window.CumulusID = { profile: () => current()?.profile ?? null, token: () => current()?.token ?? null, signIn, signOut };

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const start = () => finish().finally(render);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
