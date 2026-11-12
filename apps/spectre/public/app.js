// +SPCTR web client. No framework: small render functions over a JSON API.

const $ = (sel, el = document) => el.querySelector(sel);
const root = $("#root");
const STAGE_LABEL = { lead: "Lead", qualified: "Qualified", discovery: "Discovery", proposal: "Proposal", negotiation: "Negotiation", won: "Won", lost: "Lost" };
const OPEN = ["lead", "qualified", "discovery", "proposal", "negotiation"];

/* ---------------- helpers ---------------- */

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n, cur = "USD") => new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n || 0);
const pct = (p) => `${Math.round((p ?? 0) * 100)}%`;
const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
const ago = (iso) => {
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  return d < 30 ? `${Math.round(d)} days ago` : date(iso);
};
const initials = (name) => (name || "?").split(/[\s._-]+/).map((s) => s[0]).join("").slice(0, 2).toUpperCase();

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-spectre": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { state.me = null; render(); throw new Error(data.error || "Please sign in"); }
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong"), { status: res.status, code: data.code });
  return data;
}

const icon = {
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  pipeline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="7" rx="1.5"/></svg>',
  accounts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 21V7l8-4 8 4v14"/><path d="M9 21v-6h6v6"/></svg>',
  people: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.7 3 2.4 3.5 5.2"/></svg>',
  conjure: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8c3-3 5-3 7 0M12 6c3-3 5-3 7 0M6 15c3-3 5-3 7 0M15 13c2-2 4-2 6 0"/></svg>',
  metatron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 20h18"/><path d="M4 16c4-1 6-7 10-8s5 1 6 0"/><path d="M4 16c4 0 7-3 10-3s4 2 6 2" opacity=".45"/></svg>',
  agents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6"/></svg>',
  health: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  menu: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
};

/* ---------------- passkeys (WebAuthn) ---------------- */

const b64uToBuf = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0)).buffer;
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function createPasskey(o) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: b64uToBuf(o.challenge),
      rp: o.rp,
      user: { id: b64uToBuf(o.user.id), name: o.user.name, displayName: o.user.displayName },
      pubKeyCredParams: o.pubKeyCredParams,
      authenticatorSelection: o.authenticatorSelection,
      excludeCredentials: o.excludeCredentials.map((c) => ({ type: "public-key", id: b64uToBuf(c.id) })),
      attestation: "none",
      timeout: o.timeout,
    },
  });
  return { clientDataJSON: bufToB64u(cred.response.clientDataJSON), attestationObject: bufToB64u(cred.response.attestationObject) };
}

async function usePasskey(o) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64uToBuf(o.challenge),
      rpId: o.rpId,
      allowCredentials: o.allowCredentials.map((c) => ({ type: "public-key", id: b64uToBuf(c.id) })),
      userVerification: o.userVerification,
      timeout: o.timeout,
    },
  });
  return {
    credentialId: bufToB64u(cred.rawId),
    clientDataJSON: bufToB64u(cred.response.clientDataJSON),
    authenticatorData: bufToB64u(cred.response.authenticatorData),
    signature: bufToB64u(cred.response.signature),
  };
}

/* ---------------- state & routing ---------------- */

const state = { me: undefined, thread: [] };

function route() {
  const [page, id] = location.hash.replace(/^#\/?/, "").split("/");
  return { page: page || "today", id };
}
window.addEventListener("hashchange", () => render());

async function boot() {
  try { state.me = await api("GET", "/api/me"); } catch { state.me = null; }
  render();
}

function render() {
  const { page, id } = route();
  if (!state.me) {
    if (page === "mfa" && id) return renderMfa(id);
    return renderAuth(page === "signin-error" && id ? decodeURIComponent(id) : "");
  }
  renderShell(page);
  const views = { today: renderToday, pipeline: renderPipeline, accounts: id ? () => renderAccount(id) : renderAccounts, people: renderPeople, health: renderHealth, agents: renderAgents, conjure: id ? () => renderSimulation(id) : renderConjure, metatron: renderMetatron, settings: renderSettings };
  (views[page] || renderToday)().catch((e) => { $("main").innerHTML = `<div class="page"><div class="empty">${esc(e.message)}</div></div>`; });
}

/* ---------------- sign-in ---------------- */

/** Path back to a product sign-in that opened this page, or "". */
function productReturn() {
  try {
    const next = new URLSearchParams(location.search).get("next") || "";
    if (!(next.startsWith("/api/id/") || next.startsWith("/realms/cumulus/"))) return "";
    if (next.startsWith("//") || next.includes("\\")) return "";
    const u = new URL(next, location.origin);
    if (u.origin !== location.origin) return "";
    if (!(u.pathname.startsWith("/api/id/") || u.pathname.startsWith("/realms/cumulus/"))) return "";
    return u.pathname + u.search;
  } catch { return ""; }
}

function goAfterSignIn(apiNext) {
  const next = typeof apiNext === "string" && (apiNext.startsWith("/api/id/") || apiNext.startsWith("/realms/cumulus/")) ? apiNext : productReturn();
  if (next) { location.assign(next); return; }
  location.hash = "#/today";
  render();
}

function renderAuth(message = "") {
  root.innerHTML = `
    <div class="auth"><div class="auth-card">
      <div class="logo">+SPCTR<sup class="tm">™</sup></div>
      <p class="muted">One Cumulus://ID<sup class="tm">™</sup> for every Infinitum product</p>
      <button class="btn primary" id="signin">Sign in with Cumulus ID</button>
      <div class="social" id="social"></div>
      <div class="divider">No Cumulus ID yet?</div>
      <input class="input" id="username" placeholder="Choose a username" autocomplete="username webauthn" autocapitalize="none" spellcheck="false">
      <button class="btn" id="signup">Create a Cumulus ID</button>
      <div class="error" id="err"></div>
      <p class="faint small">Your Cumulus ID is unlocked by your device, with your fingerprint, face or screen lock. No password to remember.</p>
    </div></div>`;
  const err = $("#err");
  err.textContent = message;
  // A product's "Create a Cumulus ID" button lands here with ?create=1.
  if (new URLSearchParams(location.search).get("create") === "1") $("#username").focus();
  const fail = (e) => { err.textContent = e.name === "NotAllowedError" ? "Sign-in was cancelled." : e.message; };
  // Social sign-in buttons for every provider the server has configured.
  api("GET", "/api/auth/providers").then((providers) => {
    const back = productReturn();
    const q = back ? `?next=${encodeURIComponent(back)}` : "";
    $("#social").innerHTML = providers.map((p) => `<a class="btn" href="/api/auth/oauth/${esc(p.id)}/start${q}">Continue with ${esc(p.label)}</a>`).join("");
  }).catch(() => {});

  $("#signin").onclick = async () => {
    err.textContent = "";
    try {
      const { options } = await api("POST", "/api/auth/signin", {});
      await finishSignIn(await usePasskey(options));
    } catch (e) { fail(e); }
  };
  $("#signup").onclick = async () => {
    err.textContent = "";
    const username = $("#username").value.trim();
    if (!username) { err.textContent = "Choose a username first."; return; }
    try {
      const { cid, options } = await api("POST", "/api/auth/signup", { username });
      const response = await createPasskey(options);
      const done = await api("POST", "/api/auth/signup/finish", { cid, response });
      await finishSignIn(await usePasskey(done.options));
    } catch (e) { fail(e); }
  };
}

async function finishSignIn(response) {
  const r = await api("POST", "/api/auth/signin/finish", { response });
  if (r.status === "mfa_required") {
    const code = prompt("Enter the 6-digit code from your authenticator app");
    if (!code) throw new Error("Sign-in needs your authenticator code.");
    await api("POST", "/api/auth/mfa", { mfaToken: r.mfaToken, code });
  }
  state.me = await api("GET", "/api/me");
  goAfterSignIn();
}

function renderMfa(mfaToken) {
  root.innerHTML = `
    <div class="auth"><div class="auth-card">
      <div class="logo">+SPCTR<sup class="tm">™</sup></div>
      <p class="muted">Enter the 6-digit code from your authenticator app</p>
      <input class="input code" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">
      <button class="btn primary" id="verify">Verify</button>
      <div class="error" id="err"></div>
      <a class="faint small" href="#/">Use a different sign-in method</a>
    </div></div>`;
  $("#code").focus();
  const submit = async () => {
    try {
      const done = await api("POST", "/api/auth/mfa", { mfaToken, code: $("#code").value.trim() });
      state.me = await api("GET", "/api/me");
      goAfterSignIn(done && done.next);
    } catch (e) { $("#err").textContent = e.message; }
  };
  $("#verify").onclick = submit;
  $("#code").onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

/* ---------------- shell ---------------- */

function renderShell(page) {
  if (!$(".shell")) {
    root.innerHTML = `
      <div class="shell">
        <button class="btn ghost small menu-btn" id="menu" aria-label="Menu">${icon.menu}</button>
        <aside class="side">
          <div class="brand">+SPCTR<sup class="tm">™</sup></div>
          <input class="input small" id="global-search" placeholder="Search…" style="margin:8px 12px;width:calc(100% - 24px)">
          <nav class="nav">
            <a href="#/today" data-p="today">${icon.today}Today</a>
            <a href="#/pipeline" data-p="pipeline">${icon.pipeline}Pipeline</a>
            <a href="#/accounts" data-p="accounts">${icon.accounts}Accounts</a>
            <a href="#/people" data-p="people">${icon.people}People</a>
            <a href="#/health" data-p="health">${icon.health}Data health</a>
            <a href="#/agents" data-p="agents">${icon.agents}Agents<span class="badge hidden" id="agents-badge"></span></a>
            <a href="#/conjure" data-p="conjure">${icon.conjure}<span>CONJURE<sup class="tm">™</sup></span></a>
            <a href="#/metatron" data-p="metatron">${icon.metatron}<span>METATRON¹⁰⁰<sup class="tm">™</sup></span></a>
          </nav>
          <div class="spacer"></div>
          <nav class="nav"><a href="/labyrinth">Labyrinth *LBRNTH<sup class="tm">™</sup></a><a href="#/settings" data-p="settings">${icon.settings}Settings</a></nav>
          <div class="me">
            <div class="avatar">${esc(initials(state.me.username))}</div>
            <div class="who"><div>${esc(state.me.username)}</div>${state.me.cumulus
              ? `<a class="faint small" href="${esc(state.me.cumulus.mail.url)}" target="_blank" rel="noopener noreferrer">${esc(state.me.mailAddress)}${state.me.cumulus.mail.unread ? ` · ${state.me.cumulus.mail.unread} unread` : ""}</a>`
              : `<div class="faint small">${esc(state.me.mailAddress)}</div>`}</div>
          </div>
          <button class="btn ghost small" id="signout">Sign out</button>
        </aside>
        <main></main>
      </div>`;
    $("#menu").onclick = () => $(".shell").classList.toggle("open");
    $("#signout").onclick = async () => { await api("POST", "/api/auth/signout"); state.me = null; render(); };
    const gs = $("#global-search");
    if (gs) {
      gs.onkeydown = async (e) => {
        if (e.key === "Enter") {
          const q = gs.value.trim();
          if (!q) return;
          try {
            const r = await api("GET", `/api/search?q=${encodeURIComponent(q)}`);
            const lines = [
              ...r.companies.map((c) => `Account: ${c.name}`),
              ...r.contacts.map((c) => `Person: ${c.name}`),
              ...r.deals.map((d) => `Deal: ${d.name}`),
            ];
            const html = lines.length 
              ? `<div class="list">${lines.map(l => `<div class="item"><div class="main">${esc(l)}</div></div>`).join("")}</div>`
              : `<div class="empty">No results for "${esc(q)}"</div>`;
            modal(`<h2>Search: ${esc(q)}</h2><p class="faint small">${r.companies.length} accounts · ${r.contacts.length} people · ${r.deals.length} deals</p>${html}`, () => {});
          } catch (err) { toast(err.message); }
        }
      };
    }
  }
  $(".shell").classList.remove("open");
  document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.p === page));
}

const main = () => $("main");
const fillBars = (el) => el.querySelectorAll("[data-w]").forEach((b) => { b.style.width = b.dataset.w; });

/* ---------------- Today ---------------- */

async function renderToday() {
  const kind = new URLSearchParams(location.search).get("act") || "";
  const [t, m, acts, actSum] = await Promise.all([api("GET", "/api/today"), api("GET", "/api/metrics"), api("GET", `/api/activities?limit=8${kind ? `&kind=${kind}` : ""}`), api("GET", "/api/activities/summary")]);
  const first = state.thread.length === 0;
  main().innerHTML = `
    <div class="page narrow">
      ${first ? `<div class="hero"><h1>What can I help with?</h1></div>` : ""}
      <div class="thread">${state.thread.map((m) => `<div class="msg ${m.role}${m.notice ? " notice" : ""}">${esc(m.text)}</div>`).join("")}</div>
      <form class="composer" id="ask">
        <textarea id="q" rows="1" placeholder="Ask +SPCTR™ anything" aria-label="Ask +SPCTR™"></textarea>
        <button class="btn primary send" aria-label="Send">${icon.send}</button>
      </form>
      ${first ? `<div class="suggestions">
        <button data-q="Which deals are most at risk this month, and why?">Deals at risk</button>
        <button data-q="Which government accounts have budget this quarter and no meeting booked?">Government accounts without meetings</button>
        <button data-q="Summarize my pipeline for a board update.">Board summary</button>
      </div>` : ""}

      <div class="section stats">
        <div class="stat"><div class="muted small">Open deals</div><div class="v">${t.totals.openDeals}</div></div>
        <div class="stat"><div class="muted small">Pipeline</div><div class="v">${money(t.totals.pipeline)}</div></div>
        <div class="stat"><div class="muted small">Weighted</div><div class="v">${money(t.totals.weighted)}</div></div>
        <div class="stat"><div class="muted small">Avg win %</div><div class="v">${m.avgProbability ? Math.round(m.avgProbability * 100) + "%" : "—"}</div></div>
        <div class="stat"><div class="muted small">Accounts</div><div class="v">${m.companies}</div></div>
        <div class="stat"><div class="muted small">People</div><div class="v">${m.contacts}</div></div>
        ${m.byKind ? Object.entries(m.byKind).map(([k, v]) => `<div class="stat"><div class="muted small">${esc(k)}</div><div class="v">${v}</div></div>`).join("") : ""}
        ${m.byIndustry ? Object.entries(m.byIndustry).slice(0, 4).map(([k, v]) => `<div class="stat"><div class="muted small">${esc(k)}</div><div class="v">${v}</div></div>`).join("") : ""}
      </div>

      <div class="section"><h2>Next best actions</h2>
        <button class="btn small" id="run-exec">Run AI actions</button>
        ${t.actions.length ? `<div class="list">${t.actions.slice(0, 8).map((a) => `
          <button class="item" data-deal="${esc(a.dealId)}">
            <span class="pill p${a.priority}">${a.priority === 1 ? "Today" : a.priority === 2 ? "This week" : "Soon"}</span>
            <div class="main"><div class="title">${esc(a.action)}</div><div class="sub">${esc(a.company ?? "")} · ${esc(a.deal)} · ${esc(a.why)}</div></div>
            <div class="muted small">${money(a.amount, a.currency)}</div>
          </button>`).join("")}</div>` : `<div class="empty">No open deals yet. <a href="#/pipeline">Add your first deal</a>.</div>`}
      </div>

      ${t.alerts.length ? `<div class="section"><h2>Risk alerts</h2><div class="list">${t.alerts.slice(0, 6).map((a) => `
        <button class="item" data-deal="${esc(a.dealId)}"><span class="pill ${a.severity}">${a.severity}</span><div class="main">${esc(a.message)}</div></button>`).join("")}</div></div>` : ""}

      <div class="section"><h2>Recent activity</h2>
        <div class="faint small">${Object.entries(actSum.byKind || {}).map(([k, v]) => `${k}: ${v}`).join(" · ") || "No activities"}</div>
        <select class="input small" id="act-filter" style="margin-bottom:8px"><option value="">All</option><option value="note" ${kind==="note"?"selected":""}>Notes</option><option value="call" ${kind==="call"?"selected":""}>Calls</option><option value="email" ${kind==="email"?"selected":""}>Emails</option><option value="meeting" ${kind==="meeting"?"selected":""}>Meetings</option><option value="task" ${kind==="task"?"selected":""}>Tasks</option></select>
        ${acts.activities.length ? `<div class="list">${acts.activities.map((a) => `<div class="item"><div class="main"><div class="title">${esc(a.summary)}</div><div class="sub">${esc(a.kind)} · ${ago(a.at)}</div></div></div>`).join("")}</div>` : `<div class="empty">No activity yet.</div>`}
      </div>
      <div class="section"><h2>Forecast</h2>
        <table class="simple"><thead><tr><th>Month</th><th class="num">Won</th><th class="num">Weighted</th><th class="num">Best case</th></tr></thead>
        <tbody>${t.forecast.map((f) => `<tr><td>${new Date(f.period + "-01T00:00:00Z").toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</td><td class="num">${money(f.committed)}</td><td class="num">${money(f.weighted)}</td><td class="num">${money(f.bestCase)}</td></tr>`).join("")}</tbody></table>
        <p class="faint small">Weighted uses each deal's win probability. Forecasts support your judgment; they're estimates, not guarantees.</p>
      </div>
    </div>`;

  const q = $("#q");
  q.addEventListener("input", () => { q.style.height = "auto"; q.style.height = q.scrollHeight + "px"; });
  q.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#ask").requestSubmit(); } });
  $("#ask").onsubmit = (e) => { e.preventDefault(); ask(q.value); };
  document.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => ask(b.dataset.q)));
  document.querySelectorAll("[data-deal]").forEach((b) => (b.onclick = () => openDeal(b.dataset.deal)));
  $("#act-filter")?.addEventListener("change", () => {
    const v = $("#act-filter").value;
    if (v) history.replaceState(null, "", `?act=${v}`);
    else history.replaceState(null, "", location.pathname);
    renderToday();
  });
  $("#run-exec")?.addEventListener("click", async () => {
    toast("Running actions…");
    try {
      const r = await api("POST", "/api/execution/run", {});
      toast("Actions executed");
      console.log(r);
      renderToday();
    } catch (e) { toast(e.message); }
  });
}

async function ask(question) {
  question = question.trim();
  if (!question) return;
  state.thread.push({ role: "user", text: question });
  state.thread.push({ role: "ai", text: "Thinking…", pending: true });
  await renderToday();
  try {
    const { answer, conjure } = await api("POST", "/api/ask", { question });
    const slot = state.thread.length - 1;
    state.thread[slot] = { role: "ai", text: answer };
    // @conjure: follow the live forecast round by round until the report is in.
    if (conjure && !["done", "failed", "cancelled"].includes(conjure.status)) {
      (async () => {
        for (let i = 0; i < 400; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const live = await api("GET", `/api/conjure/live/${encodeURIComponent(conjure.id)}`).catch(() => null);
          if (!live) return;
          state.thread[slot] = { role: "ai", text: live.text };
          await renderToday();
          if (["done", "failed", "cancelled"].includes(live.prediction.status)) return;
        }
      })();
    }
  } catch (e) {
    state.thread[state.thread.length - 1] = { role: "ai", text: e.message, notice: true };
  }
  await renderToday();
  $("#q")?.focus();
}

/* ---------------- Pipeline ---------------- */

async function renderPipeline() {
  const params = new URLSearchParams(location.search);
  const min = params.get("min") || "";
  const stage = params.get("stage") || "";
  const before = params.get("before") || "";
  const qs = [min && `minAmount=${min}`, stage && `stage=${stage}`, before && `closingBefore=${before}`].filter(Boolean).join("&");
  const [{ deals }, stats] = await Promise.all([api("GET", `/api/deals${qs ? `?${qs}` : ""}`), api("GET", "/api/pipeline/stats")]);
  const cols = [...OPEN, "won"];
  main().innerHTML = `
    <div class="page wide">
      <div class="page-head"><h1>Pipeline</h1><div class="row"><input class="input small" id="min-amount" placeholder="Min amount" value="${esc(min)}" style="width:120px">
            <select class="input small" id="stage-filter" style="width:120px"><option value="">All stages</option>${Object.keys(STAGE_LABEL).map((s) => `<option value="${s}" ${stage === s ? "selected" : ""}>${STAGE_LABEL[s]}</option>`).join("")}</select>
            <input class="input small" id="before-filter" type="date" value="${esc(before)}" style="width:140px"><button class="btn primary" id="new-deal">New deal</button></div></div>
      <div class="faint small">${Object.entries(stats.byStage || {}).map(([s, v]) => `${STAGE_LABEL[s] || s}: ${v.count}`).join(" · ")}</div>
      <div class="board">${cols.map((s) => {
        const list = deals.filter((d) => d.stage === s);
        return `<div class="col"><div class="col-head"><span>${STAGE_LABEL[s]}</span><span class="faint">${money(list.reduce((n, d) => n + d.amount, 0))}</span></div>
          ${list.map((d) => `<button class="card" data-deal="${esc(d.id)}">
            <div class="name">${esc(d.name)}</div><div class="muted small">${esc(d.company ?? "")}</div>
            <div class="meta"><span>${money(d.amount, d.currency)}</span><span>${s === "won" ? "Won" : pct(d.score?.probability)}</span>${d.score?.risk && d.score.risk !== "low" ? `<span class="pill ${d.score.risk}">${d.score.risk}</span>` : ""}</div>
            ${s === "won" ? "" : `<div class="bar"><i data-w="${pct(d.score?.probability)}"></i></div>`}
          </button>`).join("") || `<div class="faint small pad6">No deals</div>`}
        </div>`;
      }).join("")}</div>
    </div>`;
  fillBars(main());
  $("#new-deal").onclick = () => newDealForm();
  const applyFilter = () => {
    const m = $("#min-amount")?.value || "";
    const s = $("#stage-filter")?.value || "";
    const b = $("#before-filter")?.value || "";
    const p = [];
    if (m) p.push(`min=${m}`);
    if (s) p.push(`stage=${s}`);
    if (b) p.push(`before=${b}`);
    history.replaceState(null, "", p.length ? `?${p.join("&")}` : location.pathname);
    renderPipeline();
  };
  $("#min-amount")?.addEventListener("change", applyFilter);
  $("#stage-filter")?.addEventListener("change", applyFilter);
  $("#before-filter")?.addEventListener("change", applyFilter);
  document.querySelectorAll("[data-deal]").forEach((b) => (b.onclick = () => openDeal(b.dataset.deal)));
}

/* ---------------- Deal drawer ---------------- */

async function openDeal(id) {
  const d = await api("GET", `/api/deals/${encodeURIComponent(id)}`);
  closeDrawer();
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <div class="drawer-bg"></div>
    <aside class="drawer" role="dialog" aria-label="${esc(d.deal.name)}">
      <button class="btn ghost small close" aria-label="Close">Close</button>
      <div class="muted small">${esc(d.company.name)}</div>
      <h2>${esc(d.deal.name)}</h2>
      <div class="row small muted">${money(d.deal.amount, d.deal.currency)} · closes ${date(d.deal.closeDate)} · ${esc(d.deal.market)}</div>

      <div class="section"><div class="row">
        <select class="input" id="stage" aria-label="Stage">${Object.keys(STAGE_LABEL).map((s) => `<option value="${s}" ${s === d.deal.stage ? "selected" : ""}>${STAGE_LABEL[s]}</option>`).join("")}</select>
      </div></div>

      ${OPEN.includes(d.deal.stage) ? `
      <div class="section"><h2>Win probability: ${pct(d.score.probability)} <span class="pill ${d.score.risk}">${d.score.risk} risk</span></h2>
        <div class="factor"><span class="muted">Typical for ${STAGE_LABEL[d.deal.stage].toLowerCase()} stage</span><span>${pct(d.score.base)}</span></div>
        ${d.score.factors.map((f) => `<div class="factor"><span>${esc(f.label)}</span><span class="${f.effect >= 1 ? "up" : "down"}">${f.effect >= 1 ? "▲" : "▼"} ×${f.effect}</span></div>`).join("")}
      </div>
      <div class="section"><h2>Next best action</h2><div class="next"><div class="act">${esc(d.next.action)}</div><div class="muted small">${esc(d.next.why)}</div></div>
        <button class="btn small" id="rehearse">Rehearse with AI</button><button class="btn small" id="simulate">Simulate with CONJURE<sup class="tm">™</sup></button></div>` : ""}

      <div class="section"><h2>People</h2>
        ${d.contacts.length ? d.contacts.map((c) => `<div class="factor"><span>${esc(c.name)}<span class="muted"> · ${esc(c.title ?? "")}</span></span><span class="pill">${esc(c.influence ?? "contact")}</span></div>`).join("") : `<div class="muted small">No one linked yet.</div>`}
      </div>

      <div class="section"><h2>Log activity</h2>
        <form id="log" class="grid2">
          <select class="input" name="kind"><option value="call">Call</option><option value="email">Email</option><option value="meeting">Meeting</option><option value="note">Note</option><option value="task">Task</option></select>
          <label class="row small muted"><input type="checkbox" name="inbound"> Customer initiated</label>
          <textarea class="input" name="summary" placeholder="What happened?" required></textarea>
          <div class="row"><input class="input hidden" type="date" name="dueAt" aria-label="Due date"><button class="btn primary">Save</button></div>
        </form>
      </div>

      <div class="section timeline"><h2>Activity</h2>
        ${d.activities.map((a) => `<div class="ev"><div class="when">${esc(a.kind)} · ${ago(a.at)}${a.kind === "task" ? (a.done ? " · done" : ` · due ${date(a.dueAt)} <button class="btn small ghost" data-done="${esc(a.id)}">Mark done</button>`) : ""}</div>${esc(a.summary)}</div>`).join("") || `<div class="muted small">Nothing logged yet.</div>`}
      </div>

      <div class="section timeline"><h2>Audit trail</h2>
        <p class="faint small">Recorded on Firmament Network<sup class="tm">™</sup>. Each entry is signed and linked to the one before it.</p>
        ${d.history.map((h) => `<div class="ev"><div class="when">${date(h.at)} · ${esc(h.actor === state.me.cid ? "you" : h.actor)}</div>${esc(describeEvent(h.payload))}<div class="hash">${esc(h.hash.slice(0, 16))}…</div></div>`).join("")}
      </div>
    </aside>`;
  document.body.appendChild(wrap);
  wrap.id = "drawer";
  $("#simulate", wrap)?.addEventListener("click", async () => {
    toast("Building the simulation…");
    try {
      const sim = await api("POST", "/api/conjure", { dealId: id, agents: 16, rounds: 4 });
      closeDrawer();
      location.hash = `#/conjure/${sim.id}`;
    } catch (e) { toast(e.message); }
  });
  $("#rehearse", wrap)?.addEventListener("click", async () => {
    toast("Rehearsing…");
    try {
      const r = await api("POST", "/api/rehearse", { dealId: id });
      showRunModal("Deal Rehearsal", r);
    } catch (e) { toast(e.message); }
  });
  const close = () => closeDrawer();
  $(".drawer-bg", wrap).onclick = close;
  $(".close", wrap).onclick = close;
  const form = $("#log", wrap);
  form.kind.onchange = () => form.dueAt.classList.toggle("hidden", form.kind.value !== "task");
  form.onsubmit = async (e) => {
    e.preventDefault();
    await api("POST", "/api/activities", { kind: form.kind.value, summary: form.summary.value, inbound: form.inbound.checked, dealId: id, dueAt: form.dueAt.value ? new Date(form.dueAt.value).toISOString() : undefined });
    toast("Activity logged");
    openDeal(id);
    refreshBehind();
  };
  $("#stage", wrap).onchange = async (e) => {
    const stage = e.target.value;
    let lostReason;
    if (stage === "lost") { lostReason = prompt("Why was it lost? This improves your forecasts."); if (!lostReason) { e.target.value = d.deal.stage; return; } }
    await api("POST", `/api/deals/${encodeURIComponent(id)}/stage`, { stage, lostReason });
    toast(`Moved to ${STAGE_LABEL[stage]}`);
    openDeal(id);
    refreshBehind();
  };
  wrap.querySelectorAll("[data-done]").forEach((b) => (b.onclick = async () => { await api("POST", `/api/activities/${b.dataset.done}/complete`); openDeal(id); refreshBehind(); }));
}

function describeEvent(p) {
  if (p.event === "stage_changed") return `Stage ${STAGE_LABEL[p.from]} → ${STAGE_LABEL[p.to]}${p.lostReason ? ` (${p.lostReason})` : ""}`;
  if (p.event === "created") return "Deal created";
  if (p.event === "updated") return `Updated ${Object.keys(p.changes || {}).join(", ")}`;
  return p.event;
}

function closeDrawer() { $("#drawer")?.remove(); }
function refreshBehind() { const { page } = route(); if (page === "today") renderToday(); if (page === "pipeline") renderPipeline(); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

/* ---------------- Accounts ---------------- */

async function renderAccounts() {
  const params = new URLSearchParams(location.search);
  const industry = params.get("industry") || "";
  const sort = params.get("sort") || "";
  const researched = params.get("researched") || "";
  const minConf = params.get("minConf") || "";
  const qs = [industry && `industry=${encodeURIComponent(industry)}`, sort && `sort=${sort}`, researched && `researched=${researched}`, minConf && `minConfidence=${minConf}`].filter(Boolean).join("&");
  const [list, recs, queue, qStats] = await Promise.all([
    api("GET", `/api/companies${qs ? `?${qs}` : ""}`),
    api("GET", "/api/research/recommendations").catch(() => ({ recommendations: [] })),
    api("GET", "/api/research/queue").catch(() => ({ queue: [] })),
    api("GET", "/api/research/queue/stats").catch(() => ({ queued: 0, done: 0 }))
  ]);
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Accounts</h1><div class="row"><input class="input small" id="industry-filter" placeholder="Industry" value="${esc(industry)}" style="width:140px">
            <select class="input small" id="sort-filter" style="width:100px"><option value="">Name</option><option value="deals" ${sort === "deals" ? "selected" : ""}>Deals</option></select>
            <select class="input small" id="researched-filter" style="width:120px"><option value="">All</option><option value="1" ${researched === "1" ? "selected" : ""}>Researched</option><option value="0" ${researched === "0" ? "selected" : ""}>Not researched</option></select>
            <select class="input small" id="conf-filter" style="width:110px"><option value="">Any conf</option><option value="0.6" ${minConf === "0.6" ? "selected" : ""}>≥0.6</option><option value="0.7" ${minConf === "0.7" ? "selected" : ""}>≥0.7</option></select><button class="btn" id="process-queue">Process queue</button><button class="btn" id="research-all">Research all</button><button class="btn" id="prospect">Prospect with AI</button><button class="btn primary" id="new-co">New account</button></div></div>
      ${qStats.queued ? `<div class="faint small">Queue: ${qStats.queued} pending · ${qStats.done} done</div>` : ""}
      ${queue.queue?.length ? `<div class="section"><h2>Research queue</h2><div class="list">${queue.queue.slice(0, 5).map((r) => `<div class="item"><div class="main"><div class="title">${esc(r.name)}</div><div class="sub">priority ${r.priority} · ${r.factCount} facts · ${r.ageDays < 999 ? r.ageDays + "d" : "never"}</div></div><button class="btn ghost small" data-unqueue="${esc(r.id)}">Remove</button></div>`).join("")}</div></div>` : ""}
      ${recs.recommendations?.length ? `<div class="section"><h2>Needs research</h2><div class="list">${recs.recommendations.map((r) => `<div class="item"><div class="main"><div class="title">${esc(r.name)}</div><div class="sub">${esc(r.reason)} · ${r.factCount} facts${r.ageDays < 999 ? ` · ${r.ageDays}d old` : ""}</div></div></div>`).join("")}</div></div>` : ""}
      ${list.length ? `<div class="list">${list.map((c) => `
        <a class="item" href="#/accounts/${esc(c.id)}">
          <div class="avatar">${esc(initials(c.name))}</div>
          <div class="main"><div class="title">${esc(c.name)}</div><div class="sub">${esc([c.kind, c.industry, c.domain].filter(Boolean).join(" · "))}</div></div>
          <div class="muted small"><span>${c.openDeals === 1 ? "1 open deal" : `${c.openDeals} open deals`}</span> · <span>${c.contacts === 1 ? "1 person" : `${c.contacts} people`}</span>${c.researchFacts ? ` · <span>${c.researchFacts === 1 ? "1 AI fact" : `${c.researchFacts} AI facts`}</span>${c.lastResearch ? ` (${ago(c.lastResearch)})` : ""}` : ""}</div>
          <button class="btn ghost small" data-queue="${esc(c.id)}">Queue</button>
        </a>`).join("")}</div>` : `<div class="empty">Add a company or government agency to start.</div>`}
    </div>`;
  $("#new-co").onclick = () => newCompanyForm();
  document.querySelectorAll("[data-unqueue]").forEach((b) => (b.onclick = async () => {
    try {
      await api("POST", "/api/research/queue/remove", { companyId: b.dataset.unqueue });
      toast("Removed from queue");
      renderAccounts();
    } catch (e) { toast(e.message); }
  }));
  document.querySelectorAll("[data-queue]").forEach((b) => (b.onclick = async () => {
    try {
      await api("POST", "/api/research/queue", { companyId: b.dataset.queue });
      toast("Added to research queue");
      renderAccounts();
    } catch (e) { toast(e.message); }
  }));
  const apply = () => {
    const i = $("#industry-filter")?.value || "";
    const s = $("#sort-filter")?.value || "";
    const r = $("#researched-filter")?.value || "";
    const c = $("#conf-filter")?.value || "";
    const p = [];
    if (i) p.push(`industry=${encodeURIComponent(i)}`);
    if (s) p.push(`sort=${s}`);
    if (r) p.push(`researched=${r}`);
    if (c) p.push(`minConf=${c}`);
    history.replaceState(null, "", p.length ? `?${p.join("&")}` : location.pathname);
    renderAccounts();
  };
  $("#industry-filter")?.addEventListener("change", apply);
  $("#sort-filter")?.addEventListener("change", apply);
  $("#researched-filter")?.addEventListener("change", apply);
  $("#conf-filter")?.addEventListener("change", apply);
  $("#process-queue").onclick = async () => {
    toast("Processing research queue…");
    try {
      const r = await api("POST", "/api/research/queue/process", {});
      toast(`Processed ${r.processed} accounts`);
      renderAccounts();
    } catch (e) { toast(e.message); }
  };
  $("#research-all").onclick = async () => {
    toast("Researching all accounts…");
    try {
      const r = await api("POST", "/api/research/all", {});
      toast(`Researched ${r.researched} accounts`);
      renderAccounts();
    } catch (e) { toast(e.message); }
  };
  $("#prospect").onclick = async () => {
    toast("Prospecting…");
    try {
      const result = await api("POST", "/api/prospect", {});
      showRunModal("Prospects", result);
    } catch (e) { toast(e.message); }
  };
}

async function renderAccount(id) {
  const a = await api("GET", `/api/companies/${encodeURIComponent(id)}`);
  const c = a.company;
  main().innerHTML = `
    <div class="page">
      <div class="page-head">
        <div><div class="muted small"><a href="#/accounts">Accounts</a> / ${esc(c.kind)}</div><h1>${esc(c.name)}</h1><div class="muted small">${esc([c.industry, c.domain].filter(Boolean).join(" · "))}</div></div>
        <div class="row"><button class="btn" id="add-person">Add person</button><button class="btn primary" id="add-deal">New deal</button></div>
      </div>

      ${a.warmPath ? `<div class="next"><div class="act">Warmest way in: ${a.warmPath.steps.length === 1 ? "you know them directly" : (a.warmPath.steps.length === 2 ? "1 introduction away" : `${a.warmPath.steps.length - 1} introductions away`)}</div><div class="muted small">Warmth ${pct(a.warmPath.warmth)}</div></div>` : ""}

      <div class="section"><h2>Buying committee</h2>
        ${a.gaps.length ? `<div class="row small wrap mb10">${a.gaps.map((g) => `<span class="pill p2">${esc(g)}</span>`).join("")}</div>` : ""}
        ${a.committee.length ? `<div class="list">${a.committee.map((p) => `<div class="item"><div class="avatar">${esc(initials(p.name))}</div><div class="main"><div class="title">${esc(p.name)}</div><div class="sub">${esc(p.title ?? "")}</div></div><span class="pill">${esc(p.influence ?? "contact")}</span></div>`).join("")}</div>` : `<div class="empty">No people yet.</div>`}
      </div>

      <div class="section"><h2>Deals</h2>
        ${a.deals.length ? `<div class="list">${a.deals.map((d) => `<button class="item" data-deal="${esc(d.id)}"><div class="main"><div class="title">${esc(d.name)}</div><div class="sub">${STAGE_LABEL[d.stage]} · closes ${date(d.closeDate)}</div></div><div class="muted small">${money(d.amount, d.currency)}${OPEN.includes(d.stage) ? ` · ${pct(d.score?.probability)}` : ""}</div></button>`).join("")}</div>` : `<div class="empty">No deals yet.</div>`}
      </div>

      <div class="section"><h2>Research</h2>
        <button class="btn" id="ai-research">Research with AI</button>
        ${c.facts.filter(f => f.source?.includes("ai-research")).length ? `<div class="faint small">${c.facts.filter(f => f.source?.includes("ai-research")).length} AI facts · last ${ago(c.facts.filter(f => f.source?.includes("ai-research")).sort((a,b)=>b.observedAt.localeCompare(a.observedAt))[0]?.observedAt)}</div>` : ""}
        ${c.facts.length ? `<div class="list">${c.facts.map((f) => `<div class="item"><div class="main"><div class="title">${esc(f.value)}</div><div class="sub">${esc(f.field)} · source: ${esc(f.source)} · ${date(f.observedAt)}</div></div></div>`).join("")}</div>` : `<div class="empty">No research yet.</div>`}
        <form id="fact" class="row wrap mt10">
          <input class="input" name="field" placeholder="Topic (e.g. funding)" required>
          <input class="input" name="value" placeholder="What you learned" required>
          <input class="input" name="source" placeholder="Source link">
          <button class="btn">Add</button>
        </form>
      </div>
    </div>`;
  $("#add-person").onclick = () => newContactForm(id);
  $("#add-deal").onclick = () => newDealForm(id);
  $("#ai-research").onclick = async () => {
    toast("Researching…");
    try {
      const result = await api("POST", `/api/companies/${encodeURIComponent(id)}/research`, {});
      const n = result.persisted || (result.facts || []).length;
      toast(`Research complete · ${n} facts saved`);
      if (result.summary || (result.facts && result.facts.length)) {
        const factsHtml = (result.facts || []).slice(0, 5).map(f => 
          `<div class="item"><div class="main"><div class="title">${esc(f.value)}</div><div class="sub">${esc(f.field)} · ${esc(f.source || "")}</div></div></div>`
        ).join("");
        modal(`<h2>Research: ${esc(c.name)}</h2>${result.summary ? `<p>${esc(result.summary)}</p>` : ""}${factsHtml ? `<div class="list">${factsHtml}</div>` : ""}`, () => {});
      }
      renderAccount(id);
    } catch (e) { toast(e.message); }
  };
  document.querySelectorAll("[data-deal]").forEach((b) => (b.onclick = () => openDeal(b.dataset.deal)));
  const f = $("#fact");
  f.onsubmit = async (e) => {
    e.preventDefault();
    await api("POST", `/api/companies/${encodeURIComponent(id)}/facts`, { field: f.field.value, value: f.value.value, source: f.source.value });
    toast("Added, with its source recorded");
    renderAccount(id);
  };
}

/* ---------------- People ---------------- */

async function renderPeople() {
  const list = await api("GET", "/api/contacts");
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>People</h1><button class="btn primary" id="new-ct">Add person</button></div>
      ${qStats.queued ? `<div class="faint small">Queue: ${qStats.queued} pending · ${qStats.done} done</div>` : ""}
      ${queue.queue?.length ? `<div class="section"><h2>Research queue</h2><div class="list">${queue.queue.slice(0, 5).map((r) => `<div class="item"><div class="main"><div class="title">${esc(r.name)}</div><div class="sub">priority ${r.priority} · ${r.factCount} facts · ${r.ageDays < 999 ? r.ageDays + "d" : "never"}</div></div><button class="btn ghost small" data-unqueue="${esc(r.id)}">Remove</button></div>`).join("")}</div></div>` : ""}
      ${recs.recommendations?.length ? `<div class="section"><h2>Needs research</h2><div class="list">${recs.recommendations.map((r) => `<div class="item"><div class="main"><div class="title">${esc(r.name)}</div><div class="sub">${esc(r.reason)} · ${r.factCount} facts${r.ageDays < 999 ? ` · ${r.ageDays}d old` : ""}</div></div></div>`).join("")}</div></div>` : ""}
      ${list.length ? `<div class="list">${list.map((c) => `
        <div class="item"><div class="avatar">${esc(initials(c.name))}</div>
          <div class="main"><div class="title">${esc(c.name)}</div><div class="sub">${esc([c.title, c.company].filter(Boolean).join(" · "))}</div></div>
          <div class="muted small">${esc(c.email ?? "")}</div>
          <button class="btn ghost small" data-research="${esc(c.id)}" data-name="${esc(c.name)}" data-company="${esc(c.company || "")}">Research</button>
          <button class="btn ghost small" data-optout="${esc(c.id)}" title="Erase this person's details and never re-add them">Opt out</button>
        </div>`).join("")}</div>` : `<div class="empty">No people yet.</div>`}
    </div>`;
  $("#new-ct").onclick = () => newContactForm();
  document.querySelectorAll("[data-research]").forEach((b) => (b.onclick = async () => {
    toast("Researching…");
    try {
      const r = await api("POST", "/api/research/contact", { name: b.dataset.name, company: b.dataset.company });
      toast("Research done");
      if (r.summary) alert(r.summary);
    } catch (e) { toast(e.message); }
  }));
  document.querySelectorAll("[data-optout]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Erase this person's details? +SPCTR™ will keep only a do-not-contact marker.")) return;
    await api("POST", `/api/contacts/${b.dataset.optout}/opt-out`);
    toast("Opted out");
    renderPeople();
  }));
}

/* ---------------- Data health ---------------- */

async function renderHealth() {
  const h = await api("GET", "/api/data-health");
  const coverage = h.researchCoverage ?? 0;
  const group = (g, kind) => `
    <div class="item"><div class="main"><div class="title">${esc(g.keep.name)}</div><div class="sub">${esc(g.reason)} · also: ${g.duplicates.map((d) => esc(d.name)).join(", ")}</div></div>
    <button class="btn small" data-merge='${esc(JSON.stringify({ kind, keepId: g.keep.id, mergeIds: g.duplicates.map((d) => d.id) }))}'>Merge</button></div>`;
  const dups = [...h.duplicateCompanies.map((g) => group(g, "company")), ...h.duplicateContacts.map((g) => group(g, "contact"))];
  main().innerHTML = `
    <div class="page narrow">
      <div class="page-head"><h1>Data health</h1></div>
      <div class="section"><div class="muted small">AI research coverage</div><div class="v">${coverage}%</div></div>
      <div class="section"><h2>Possible duplicates</h2>${dups.length ? `<div class="list">${dups.join("")}</div>` : `<div class="empty">No duplicates found.</div>`}</div>
      <div class="section"><h2>Needs attention</h2>${h.issues.length ? `<div class="list">${h.issues.map((i) => `<div class="item"><span class="pill">${i.kind === "stale_contact" ? "stale" : "missing"}</span><div class="main">${esc(i.message)}</div></div>`).join("")}</div>` : `<div class="empty">Everything looks complete.</div>`}</div>
    </div>`;
  document.querySelectorAll("[data-merge]").forEach((b) => (b.onclick = async () => {
    await api("POST", "/api/data-health/merge", JSON.parse(b.dataset.merge));
    toast("Merged. Deals and activity now point to one record.");
    renderHealth();
  }));
}

/* ---------------- Forms ---------------- */

function modal(html, onSubmit) {
  const dlg = $("#modal");
  const form = $("#modal-form");
  form.innerHTML = html + `<div class="error" id="m-err"></div><div class="actions"><button type="button" class="btn" id="m-cancel">Cancel</button><button class="btn primary" id="m-ok">Save</button></div>`;
  $("#m-cancel").onclick = () => dlg.close();
  form.onsubmit = async (e) => {
    e.preventDefault();
    try { await onSubmit(new FormData(form)); dlg.close(); } catch (err) { $("#m-err").textContent = err.message; }
  };
  dlg.showModal();
  form.querySelector("input, select")?.focus();
}

function newCompanyForm() {
  modal(`<h2>New account</h2>
    <label class="field">Name<input class="input" name="name" required></label>
    <div class="grid2">
      <label class="field">Website<input class="input" name="domain" placeholder="example.com"></label>
      <label class="field">Type<select class="input" name="kind"><option value="company">Company</option><option value="agency">Government agency</option><option value="partner">Partner</option><option value="investor">Investor</option></select></label>
    </div>
    <label class="field">Industry<input class="input" name="industry"></label>`, async (f) => {
    const c = await api("POST", "/api/companies", Object.fromEntries(f));
    toast("Account added");
    location.hash = `#/accounts/${c.id}`;
  });
}

async function newContactForm(companyId) {
  const companies = await api("GET", "/api/companies");
  modal(`<h2>Add person</h2>
    <div class="grid2">
      <label class="field">Name<input class="input" name="name" required></label>
      <label class="field">Title<input class="input" name="title"></label>
      <label class="field">Email<input class="input" name="email" type="email"></label>
      <label class="field">Phone<input class="input" name="phone"></label>
    </div>
    <div class="grid2">
      <label class="field">Account<select class="input" name="companyId"><option value="">None</option>${companies.map((c) => `<option value="${esc(c.id)}" ${c.id === companyId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
      <label class="field">Role in decision<select class="input" name="influence"><option value="">Unknown</option><option value="decision-maker">Decision-maker</option><option value="champion">Champion</option><option value="influencer">Influencer</option><option value="blocker">Blocker</option><option value="user">User</option></select></label>
    </div>
    <label class="row small muted"><input type="checkbox" name="knowMe"> I know this person personally</label>`, async (f) => {
    const body = Object.fromEntries(f);
    const knowMe = body.knowMe === "on";
    delete body.knowMe;
    const c = await api("POST", "/api/contacts", body);
    if (knowMe) await api("POST", "/api/relationships", { from: "me", to: c.id, strength: 4 });
    toast("Person added");
    render();
  });
}

async function newDealForm(companyId) {
  const companies = await api("GET", "/api/companies");
  if (!companies.length) { toast("Add an account first"); return newCompanyForm(); }
  const contacts = await api("GET", "/api/contacts");
  const inMonth = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  modal(`<h2>New deal</h2>
    <label class="field">Deal name<input class="input" name="name" required></label>
    <div class="grid2">
      <label class="field">Account<select class="input" name="companyId" required>${companies.map((c) => `<option value="${esc(c.id)}" ${c.id === companyId ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
      <label class="field">Market<select class="input" name="market"><option value="commercial">Commercial</option><option value="government">Government</option><option value="partnership">Partnership</option><option value="investor">Investor</option></select></label>
      <label class="field">Amount (USD)<input class="input" name="amount" type="number" min="0" step="1" required></label>
      <label class="field">Expected close<input class="input" name="closeDate" type="date" value="${inMonth}" required></label>
    </div>
    <label class="field">People involved<select class="input" name="contactIds" multiple size="4">${contacts.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.company ? ` · ${esc(c.company)}` : ""}</option>`).join("")}</select></label>`, async (f) => {
    const body = Object.fromEntries(f);
    body.contactIds = f.getAll("contactIds");
    await api("POST", "/api/deals", body);
    toast("Deal created");
    render();
  });
}

boot();

/* ---------------- Settings: sign-in methods ---------------- */

async function renderSettings() {
  const data = await api("GET", "/api/me/identities");
  const mt = await api("GET", "/api/metatron").catch(() => null);
  const mtLine = !mt ? "Default on for win probability"
    : !mt.on ? "Off. Using the baseline scorer"
    : mt.model === "metatron-logistic-v1" ? `Learned from ${mt.closedDeals} closed deals (${mt.won} won, ${mt.lost} lost)`
    : `Default model · learns from your history when it has enough closed deals (${esc(mt.learning || "")})`;
  const linked = new Map(data.linked.map((i) => [i.provider, i]));
  const label = Object.fromEntries(data.available.map((p) => [p.id, p.label]));
  for (const i of data.linked) label[i.provider] ??= i.provider;
  const ids = [...new Set([...data.available.map((p) => p.id), ...data.linked.map((i) => i.provider)])];
  main().innerHTML = `
    <div class="page narrow">
      <div class="page-head"><h1>Settings</h1></div>
      <div class="section">
        <h2>Account</h2>
        <p class="faint small">+SPCTR<sup class="tm">™</sup> 0.1.0 · METATRON¹⁰⁰<sup class="tm">™</sup> scoring on</p>
        <div class="list"><div class="item"><div class="avatar">${esc(initials(state.me.username))}</div>
          <div class="main"><div class="title">${esc(state.me.username)}</div><div class="sub">${esc(state.me.mailAddress)} · ${esc(state.me.handle)}</div></div></div></div>
      </div>
      ${state.me.cumulus ? `<div class="section">
        <h2>Included with your Cumulus://ID<sup class="tm">™</sup></h2>
        <div class="list">
          <div class="item"><div class="main"><div class="title">Cumulus://Mail</div><div class="sub">${esc(state.me.mailAddress)}${state.me.cumulus.mail.unread ? ` · ${state.me.cumulus.mail.unread} unread` : ""}</div></div>
            <a class="btn small" href="${esc(state.me.cumulus.mail.url)}" target="_blank" rel="noopener noreferrer">Open</a></div>
          <div class="item"><div class="main"><div class="title">Cumulus://Cloud<sup class="tm">™</sup> storage</div><div class="sub">${esc(state.me.cumulus.storage.label)} · shared by Mail and Cloud</div></div></div>
        </div>
        <firm-suite class="mt10" product="spectre metatron" wallet="${esc(JSON.stringify({ address: state.me.cumulus.wallet.address, balances: state.me.cumulus.wallet.balances }))}"></firm-suite>
        <p class="faint small mt10">${esc(state.me.cumulus.plan)} plan. Sign-in alerts and wallet receipts go to your Cumulus://Mail inbox.</p>
      </div>` : `<div class="section">
        <h2>FIRM Wallet<sup class="tm">™</sup></h2>
        <firm-suite product="spectre metatron"></firm-suite>
      </div>`}
      <div class="section">
        <h2>Ways to sign in</h2>
        <div class="list">
          <div class="item"><div class="main"><div class="title">Passkeys</div><div class="sub">${data.passkeys ? `${data.passkeys} on this account` : "None yet"}</div></div></div>
          ${ids.map((id) => {
            const l = linked.get(id);
            return `<div class="item"><div class="main"><div class="title">${esc(label[id])}</div>
              <div class="sub">${l ? `Linked${l.email ? ` · ${esc(l.email)}` : ""} · ${date(l.linkedAt)}` : "Not linked"}</div></div>
              ${l ? `<button class="btn small" data-unlink="${esc(id)}">Unlink</button>`
                  : data.available.some((p) => p.id === id) ? `<a class="btn small" href="/api/auth/oauth/${esc(id)}/start?link=1">Link</a>` : ""}</div>`;
          }).join("")}
        </div>
        <p class="faint small mt10">Linked accounts sign you in to this same Cumulus://ID<sup class="tm">™</sup>. Your multifactor setting still applies.</p>
      </div>
      <div class="section">
        <h2>Data</h2>
        <button class="btn" id="export-data">Export workspace JSON</button>
      </div>
      <div class="section">
        <h2>AI</h2>
        <div class="list">
          <div class="item"><div class="main"><div class="title">METATRON¹⁰⁰<sup class="tm">™</sup> scoring</div><div class="sub">${mtLine}</div></div></div>
          <div class="item"><div class="main"><div class="title">Research</div><div class="sub">Public web search for account facts</div></div></div>
          <div class="item"><div class="main"><div class="title">Agents</div><div class="sub">Researcher, Prospector, Deal Coach, Query</div></div></div>
        </div>
        <p class="faint small mt10">Connect OmniRoute (OMNIROUTE_API_KEY) for Ask +SPCTR<sup class="tm">™</sup>. Research uses public search. Filters available on Pipeline and Accounts.</p>
      </div>
    </div>`;
  $("#export-data")?.addEventListener("click", async () => {
    try {
      const data = await api("GET", "/api/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "spectre-export.json";
      a.click();
      toast("Export downloaded");
    } catch (e) { toast(e.message); }
  });
  main().querySelectorAll("[data-unlink]").forEach((b) => {
    b.onclick = async () => {
      try { await api("POST", `/api/me/identities/${b.dataset.unlink}/unlink`); toast("Unlinked"); renderSettings(); }
      catch (e) { toast(e.message); }
    };
  });
}

/* ---------------- Agents (SCALVS.ai) ---------------- */

const TOOL_LABEL = {
  list_accounts: "Looked at accounts",
  get_account: "Read an account",
  list_open_deals: "Looked at open deals",
  get_deal: "Read a deal",
  pipeline_forecast: "Checked the forecast",
  data_health: "Checked data health",
  web_search: "Searched the web",
  add_fact: "Proposed saving a fact",
  add_account: "Proposed a new account",
  create_task: "Proposed a task",
  log_note: "Proposed a note",
  draft_email: "Proposed an email draft",
  move_deal: "Proposed a stage change",
};
const agentState = { selected: "deal-coach", last: null };

function stepsHtml(steps) {
  if (!steps?.length) return "";
  return `<details class="steps"><summary>${steps.length === 1 ? "1 step" : `${steps.length} steps`}</summary><ol>${steps.map((st) =>
    `<li>${esc(TOOL_LABEL[st.tool] || st.tool)}${st.input?.query ? `: “${esc(st.input.query)}”` : ""}${st.error ? ` <span class="faint">(${esc(st.error)})</span>` : ""}</li>`).join("")}</ol></details>`;
}

function proposalHtml(p) {
  return `<div class="item proposal" data-prop="${esc(p.id)}"><div class="main"><div class="title">${esc(p.summary)}</div>
    <div class="sub">${esc(agentName(p.agentId))} · ${date(p.createdAt)}${p.status !== "pending" ? ` · ${esc(p.status)}` : ""}</div></div>
    ${p.status === "pending" ? `<button class="btn small" data-decide="dismiss">Dismiss</button><button class="btn small primary" data-decide="approve">Approve</button>` : ""}</div>`;
}

let agentNames = {};
const agentName = (id) => agentNames[id] || id;

function wireProposals(root, after) {
  root.querySelectorAll("[data-prop] [data-decide]").forEach((b) => {
    b.onclick = async () => {
      const id = b.closest("[data-prop]").dataset.prop;
      b.disabled = true;
      try {
        await api("POST", `/api/agents/proposals/${encodeURIComponent(id)}/${b.dataset.decide}`, {});
        toast(b.dataset.decide === "approve" ? "Approved and saved" : "Dismissed");
        after?.();
      } catch (e) { toast(e.message); b.disabled = false; }
    };
  });
}

function runHtml(r) {
  const props = (r.proposals || []).filter(Boolean);
  return `<div class="run">
    <div class="run-output">${esc(r.run.output || "(no answer)")}</div>
    ${stepsHtml(r.run.steps)}
    ${props.length ? `<h3 class="mt10">Waiting for your approval</h3><div class="list">${props.map(proposalHtml).join("")}</div>` : ""}
  </div>`;
}

function showRunModal(title, r) {
  modal(`<h2>${esc(title)}</h2>${runHtml(r)}`, () => {});
  const form = $("#modal-form");
  $("#m-ok", form).classList.add("hidden");
  $("#m-cancel", form).textContent = "Close";
  wireProposals(form, () => refreshAgentsBadge());
}

async function refreshAgentsBadge() {
  try {
    const n = (await api("GET", "/api/agents/proposals")).length;
    const b = $("#agents-badge");
    if (b) { b.textContent = n; b.classList.toggle("hidden", !n); }
  } catch {}
}

async function renderAgents() {
  const [info, pending, runs] = await Promise.all([api("GET", "/api/agents"), api("GET", "/api/agents/proposals"), api("GET", "/api/agents/runs")]);
  agentNames = Object.fromEntries(info.agents.map((a) => [a.id, a.name]));
  const sel = info.agents.find((a) => a.id === agentState.selected) || info.agents[0];
  main().innerHTML = `
    <div class="page">
      <div class="page-head"><h1>Agents</h1><span class="faint small">Powered by SCALVS.ai<sup class="tm">™</sup></span></div>
      ${info.aiConnected ? "" : `<div class="notice">AI isn't connected yet, so agents can't run. Set OMNIROUTE_API_KEY on the server.</div>`}
      ${pending.length ? `<div class="section"><h2>Waiting for your approval</h2><div class="list" id="pending">${pending.map(proposalHtml).join("")}</div></div>` : ""}
      <div class="agent-grid">${info.agents.map((a) => `<button class="agent-card${a.id === sel.id ? " active" : ""}" data-agent="${esc(a.id)}">
        <div class="title">${esc(a.name)}</div><div class="sub">${esc(a.role)}</div></button>`).join("")}</div>
      <div class="section">
        <div class="composer">
          <textarea id="agent-q" rows="1" placeholder="Ask the ${esc(sel.name)}" aria-label="Task for the ${esc(sel.name)}"></textarea>
          <button class="send" id="agent-run" aria-label="Run" ${info.aiConnected ? "" : "disabled"}>${icon.send || "↑"}</button>
        </div>
        <div class="suggestions">${sel.starters.map((t) => `<button data-starter>${esc(t)}</button>`).join("")}</div>
        <p class="faint small mt10">${sel.canPropose.length ? "Changes this agent suggests wait for your approval. Nothing is sent to customers." : "This agent only reads your data."}</p>
        <div id="agent-out">${agentState.last && agentState.last.run.agentId === sel.id ? runHtml(agentState.last) : ""}</div>
      </div>
      ${runs.length ? `<div class="section"><h2>Recent runs</h2><div class="list">${runs.slice(0, 10).map((r) => `<details class="item run-item"><summary><div class="main"><div class="title">${esc(agentName(r.agentId))}: ${esc(r.prompt.slice(0, 90))}</div><div class="sub">${r.proposalIds.length === 1 ? `${date(r.at)} · 1 proposal` : `${date(r.at)} · ${r.proposalIds.length} proposals`}</div></div></summary><div class="run-output">${esc(r.output)}</div>${stepsHtml(r.steps)}</details>`).join("")}</div></div>` : ""}
    </div>`;
  refreshAgentsBadge();
  wireProposals(main(), () => renderAgents());
  main().querySelectorAll("[data-agent]").forEach((b) => b.onclick = () => { agentState.selected = b.dataset.agent; renderAgents(); });
  const q = $("#agent-q");
  q.oninput = () => { q.style.height = "auto"; q.style.height = Math.min(q.scrollHeight, 200) + "px"; };
  const run = async () => {
    const prompt = q.value.trim();
    if (!prompt || !info.aiConnected) return;
    const out = $("#agent-out");
    out.innerHTML = `<div class="faint">${esc(sel.name)} is working…</div>`;
    $("#agent-run").disabled = true;
    try {
      agentState.last = await api("POST", `/api/agents/${encodeURIComponent(sel.id)}/run`, { prompt });
      renderAgents();
    } catch (e) {
      out.innerHTML = `<div class="error">${esc(e.message)}</div>`;
      $("#agent-run").disabled = false;
    }
  };
  $("#agent-run").onclick = run;
  q.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); run(); } };
  main().querySelectorAll("[data-starter]").forEach((b) => b.onclick = () => { q.value = b.textContent; run(); });
}

/* ---------------- CONJURE™ swarm forecasting ---------------- */

const stanceLabel = (v) => (v > 0.2 ? "for" : v < -0.2 ? "against" : "undecided");

function stanceChart(stats, poles) {
  if (!stats?.length) return "";
  const W = 560, H = 140, P = 24;
  const x = (i) => P + (stats.length === 1 ? 0 : (i * (W - 2 * P)) / (stats.length - 1));
  const y = (v) => H / 2 - (v * (H / 2 - P));
  const pts = stats.map((s, i) => `${x(i).toFixed(1)},${y(s.meanStance).toFixed(1)}`).join(" ");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Average stance by round">
    <line x1="${P}" x2="${W - P}" y1="${H / 2}" y2="${H / 2}" class="axis"/>
    <text x="${P}" y="14" class="lbl">${esc(poles.for)}</text>
    <text x="${P}" y="${H - 4}" class="lbl">${esc(poles.against)}</text>
    <polyline points="${pts}" class="line"/>
    ${stats.map((s, i) => `<circle cx="${x(i)}" cy="${y(s.meanStance)}" r="3" class="dot"><title>Round ${s.round}: ${s.meanStance}</title></circle>`).join("")}
  </svg>`;
}

/* ---------------- METATRON¹⁰⁰ ---------------- */

const moneyCompact = (n, cur = "USD") => new Intl.NumberFormat(undefined, { style: "currency", currency: cur, notation: "compact", maximumFractionDigits: 1 }).format(n || 0);
const compact = (n) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n || 0);
const signed = (n, f = compact) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${f(Math.abs(n))}`;

/**
 * Fan chart: the first line gets its 50% and 90% bands shaded, every line
 * draws its median. Lines are told apart by dash pattern as well as color.
 */
function fanChart(lines, { unit = "step", start = 1, height = 220, shade = 0, ends, note } = {}) {
  const W = 640, H = height, L = 48, R = 12, T = 10, B = 26;
  const n = lines[0].band.p50.length;
  const vals = lines.flatMap((l, i) => (i === shade ? [...l.band.p5, ...l.band.p95] : l.band.p50)).filter(Number.isFinite);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (lo === hi) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad;
  const x = (i) => L + (n === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (n - 1));
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  // Gaps (NaN) lift the pen, so one chart can hold history and forecast side by side.
  const path = (arr) => {
    let d = "", pen = false;
    arr.forEach((v, i) => {
      if (!Number.isFinite(v)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const area = (top, bottom) => {
    const idx = top.map((_, i) => i).filter((i) => Number.isFinite(top[i]) && Number.isFinite(bottom[i]));
    if (idx.length < 2) return "";
    return `M${idx.map((i) => `${x(i).toFixed(1)},${y(top[i]).toFixed(1)}`).join("L")}L${[...idx].reverse().map((i) => `${x(i).toFixed(1)},${y(bottom[i]).toFixed(1)}`).join("L")}Z`;
  };
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad];
  const first = lines[shade].band;
  return `<svg class="mt-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(lines.map((l) => l.name).join(" vs "))}">
    ${ticks.map((t) => `<line class="mt-grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="mt-axis" x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${esc(compact(t))}</text>`).join("")}
    <path class="mt-band90" d="${area(first.p95, first.p5)}"/>
    <path class="mt-band50" d="${area(first.p75, first.p25)}"/>
    ${lines.map((l, i) => `<path class="mt-line mt-l${i % 5}" d="${path(l.band.p50)}"/>`).join("")}
    <text class="mt-axis" x="${L}" y="${H - 6}">${esc(ends ? ends[0] : `${unit} ${start}`)}</text>
    <text class="mt-axis" x="${W - R}" y="${H - 6}" text-anchor="end">${esc(ends ? ends[1] : `${unit} ${start + n - 1}`)}</text>
  </svg>
  <div class="mt-legend">${lines.map((l, i) => `<span><i class="mt-key mt-l${i % 5}"></i>${esc(l.name)}</span>`).join("")}<span class="faint">${esc(note ?? `Shaded: ${lines[shade].name}, middle 50% and 90% of futures`)}</span></div>`;
}

/** History (solid) then forecast (dashed) with its range shaded. `weeks` are the history's week-start dates. */
function forecastChart(history, f, weeks) {
  const nan = (k) => Array(k).fill(NaN);
  const h = history.length;
  // Join the forecast to the last actual so the lines meet.
  const last = history[h - 1];
  const band = {
    p5: [...nan(h - 1), last, ...f.lower], p25: [...nan(h - 1), last, ...f.lower], p75: [...nan(h - 1), last, ...f.upper], p95: [...nan(h - 1), last, ...f.upper],
    p50: [...nan(h - 1), last, ...f.point],
  };
  const hist = { p50: [...history, ...nan(f.point.length)] };
  const end = new Date(Date.parse(weeks[weeks.length - 1]) + f.point.length * 7 * 86400000).toISOString();
  return fanChart([{ name: "Actual", band: hist }, { name: "Forecast", band }], {
    height: 180, shade: 1, ends: [date(weeks[0]), date(end)],
    note: `Shaded: ${Math.round(f.level * 100)}% range from the model's own past errors`,
  });
}

function tornado(rows, output) {
  if (!rows.length) return `<div class="faint small">No uncertain inputs to test.</div>`;
  const W = 640, rowH = 26, L = 150, R = 12;
  const lo = Math.min(...rows.flatMap((r) => [r.outputAtLow, r.outputAtHigh]));
  const hi = Math.max(...rows.flatMap((r) => [r.outputAtLow, r.outputAtHigh]));
  const x = (v) => L + ((v - lo) * (W - L - R)) / (hi - lo || 1);
  return `<svg class="mt-chart" viewBox="0 0 ${W} ${rows.length * rowH + 8}" role="img" aria-label="Which inputs move ${esc(output)} most">
    ${rows.map((r, i) => {
      const a = x(Math.min(r.outputAtLow, r.outputAtHigh)), b = x(Math.max(r.outputAtLow, r.outputAtHigh));
      return `<text class="mt-axis" x="${L - 8}" y="${i * rowH + 17}" text-anchor="end">${esc(r.variable)}</text>
        <rect class="${r.outputAtHigh >= r.outputAtLow ? "mt-up" : "mt-down"}" x="${a}" y="${i * rowH + 5}" width="${Math.max(2, b - a)}" height="${rowH - 10}"/>
        <title>${esc(r.variable)} from ${esc(compact(r.low))} to ${esc(compact(r.high))} moves ${esc(output)} from ${esc(compact(r.outputAtLow))} to ${esc(compact(r.outputAtHigh))}</title>`;
    }).join("")}
  </svg>
  <div class="faint small">Each bar: ${esc(output)} at the end when that input is at its 10th vs. 90th percentile. Longest bar matters most.</div>`;
}

async function renderMetatron() {
  const [tpl, sig] = await Promise.all([api("GET", "/api/metatron/templates"), api("GET", "/api/metatron/signals?weeks=26")]);
  const stageOpts = OPEN.map((s) => `<option value="${s}">${STAGE_LABEL[s]}</option>`).join("");
  main().innerHTML = `
    <div class="page narrow mt">
      <div class="page-head"><h1>METATRON¹⁰⁰<sup class="tm">™</sup></h1><span class="faint small">Prediction engine</span></div>
      <p class="muted">Runs your pipeline and your “what if?” questions forward thousands of times. The answers are ranges and chances that support your judgment, not certainties.</p>

      <div class="section"><h2>Pipeline outlook</h2>
        <form id="mt-outlook" class="mt-controls">
          <label class="field">Closing within<select class="input" name="horizonDays"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="180">180 days</option><option value="365">a year</option></select></label>
          <label class="field">Target<input class="input" name="target" inputmode="numeric" placeholder="Optional"></label>
          <label class="field">What if<select class="input" name="whatIfStage"><option value="">No change</option>${stageOpts}</select></label>
          <label class="field">win rate<select class="input" name="whatIfChange">${[-20, -10, 10, 20, 30].map((v) => `<option value="${v}" ${v === 10 ? "selected" : ""}>${v > 0 ? "+" : ""}${v} pts</option>`).join("")}</select></label>
        </form>
        <div id="mt-outlook-out"><div class="faint small">Running…</div></div>
      </div>

      <div class="section"><h2>What changed</h2>
        ${sig.notable.length ? `<div class="list">${sig.notable.map((n) => `<div class="item"><span class="pill ${n.direction === "up" ? "low" : "high"}">${n.kind === "shift" ? "new level" : n.direction === "up" ? "spike" : "dip"}</span><div class="main"><div class="title">${esc(n.headline)}</div><div class="sub">Week of ${date(n.week)}</div></div></div>`).join("")}</div>`
          : `<div class="empty">Nothing unusual in the last few weeks.</div>`}
        ${sig.bookings ? `<h2 class="mt-sub">Bookings, next 8 weeks</h2>${forecastChart(sig.series.wonValue.slice(0, -1), sig.bookings, sig.weeks.slice(0, -1))}
          <div class="faint small">Model chosen by backtest out of ${sig.bookings.candidates.length}: ${esc(sig.bookings.model)}${sig.bookings.error ? `, typically off by ${money(sig.bookings.error.mae)} a week` : ""}.</div>` : ""}
      </div>

      <div class="section"><h2>What if?</h2>
        <form id="mt-scn" class="mt-controls">
          <label class="field mt-wide">Scenario<select class="input" name="template">${tpl.templates.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join("")}</select></label>
          <button class="btn primary">Run</button>
        </form>
        <p class="muted" id="mt-question"></p>
        <details class="mt-edit"><summary class="small">Edit the model</summary>
          <p class="faint small">Variables are uncertain inputs, shocks change every step, derived values are computed in order, and update says how each stock moves. Formulas use + − × ÷ ^, comparisons, <code>a ? b : c</code> and min, max, clamp, exp, log, sqrt, normal, bernoulli.</p>
          <textarea class="input mono" id="mt-json" rows="16" spellcheck="false"></textarea>
        </details>
        <div class="error" id="mt-err"></div>
        <div id="mt-scn-out"></div>
      </div>
    </div>`;

  const of = $("#mt-outlook");
  const runOutlook = async () => {
    const q = new URLSearchParams({ horizonDays: of.horizonDays.value });
    const target = Number(String(of.target.value).replace(/[^\d.]/g, ""));
    if (target > 0) q.set("target", String(target));
    if (of.whatIfStage.value) { q.set("whatIfStage", of.whatIfStage.value); q.set("whatIfChange", of.whatIfChange.value); }
    try {
      const o = await api("GET", `/api/metatron/outlook?${q}`);
      $("#mt-outlook-out").innerHTML = o.byCurrency.length ? o.byCurrency.map((c, i) => {
        const w = o.whatIf?.byCurrency.find((x) => x.currency === c.currency);
        return `<div class="section stats">
            <div class="stat"><div class="muted small">Most likely</div><div class="v">${money(c.p50, c.currency)}</div><div class="faint small">expected ${money(c.expected, c.currency)}</div></div>
            <div class="stat"><div class="muted small">Likely range (80%)</div><div class="v">${moneyCompact(c.p10, c.currency)}–${moneyCompact(c.p90, c.currency)}</div><div class="faint small">${c.deals} deals · ${money(c.pipeline, c.currency)} in play</div></div>
            <div class="stat"><div class="muted small">${c.probTarget !== undefined ? `Chance of ${money(target, c.currency)}` : "What if"}</div><div class="v">${c.probTarget !== undefined ? pct(c.probTarget) : w ? signed(w.expected - c.expected) : "—"}</div>
              <div class="faint small">${w ? `${STAGE_LABEL[o.whatIf.stage]} ${o.whatIf.winRateChange > 0 ? "+" : ""}${o.whatIf.winRateChange} pts: expected ${money(w.expected, c.currency)}${w.probTarget !== undefined ? `, ${pct(w.probTarget)} chance` : ""}` : "Pick a stage to test a change"}</div></div>
          </div>
          ${i === 0 && c.drivers.length ? `<div class="list">${c.drivers.map((d) => `<button class="item" data-deal="${esc(d.dealId)}"><span class="pill">${esc(STAGE_LABEL[d.stage])}</span><div class="main"><div class="title">${esc(d.name)}</div><div class="sub">${pct(d.probability)} × ${money(d.amount, c.currency)}</div></div><div class="muted small">${money(d.expectedValue, c.currency)}</div></button>`).join("")}</div>` : ""}`;
      }).join("") + (o.later ? `<div class="faint small">${o.later === 1 ? "1 open deal expected to close later." : `${o.later} open deals expected to close later.`}</div>` : "")
        : `<div class="empty">No open deals close in this window. <a href="#/pipeline">Add deals</a> to see an outlook.</div>`;
      $("#mt-outlook-out").querySelectorAll("[data-deal]").forEach((b) => (b.onclick = () => openDeal(b.dataset.deal)));
    } catch (e) { $("#mt-outlook-out").innerHTML = `<div class="error">${esc(e.message)}</div>`; }
  };
  of.onchange = runOutlook;
  of.target.oninput = () => { clearTimeout(runOutlook.t); runOutlook.t = setTimeout(runOutlook, 500); };
  of.onsubmit = (e) => { e.preventDefault(); runOutlook(); };
  runOutlook();

  const sf = $("#mt-scn");
  const fill = () => {
    const t = tpl.templates.find((x) => x.id === sf.template.value);
    $("#mt-question").textContent = t.question;
    $("#mt-json").value = JSON.stringify({ model: t.model, interventions: t.interventions, events: t.events, focus: t.focus }, null, 2);
    $("#mt-scn-out").innerHTML = "";
  };
  sf.template.onchange = fill;
  fill();
  sf.onsubmit = async (e) => {
    e.preventDefault();
    $("#mt-err").textContent = "";
    let spec;
    try { spec = JSON.parse($("#mt-json").value); } catch { $("#mt-err").textContent = "The model isn't valid JSON."; return; }
    const btn = sf.querySelector("button");
    btn.disabled = true; btn.textContent = "Running futures…";
    try {
      const focus = spec.focus || spec.model?.outputs?.[0] || Object.keys(spec.model?.state || {})[0];
      const r = await api("POST", "/api/metatron/compare", { model: spec.model, interventions: spec.interventions, events: spec.events, sensitivity: focus, runs: 1000 });
      const unit = spec.model.stepUnit || "step";
      const all = [r.baseline, ...r.scenarios];
      const evNames = Object.keys(r.baseline.events);
      const fmt = (v) => compact(v);
      $("#mt-scn-out").innerHTML = `
        <h2 class="mt-sub">${esc(focus)}</h2>
        ${fanChart(all.map((s) => ({ name: s.name, band: s.series[focus] })), { unit })}
        <div class="mt-table-wrap"><table class="mt-table">
          <thead><tr><th>Scenario</th><th>${esc(focus)} at end</th><th>vs. ${esc(r.baseline.name)}</th><th>Chance higher</th>${evNames.map((n) => `<th>${esc(n)}</th>`).join("")}</tr></thead>
          <tbody>${all.map((s, i) => {
            const f = s.final[focus], d = s.delta?.[focus];
            return `<tr><td><i class="mt-key mt-l${i % 5}"></i>${esc(s.name)}${s.description ? `<div class="faint small">${esc(s.description)}</div>` : ""}</td>
              <td>${fmt(f.p50)}<div class="faint small">${fmt(f.p5)}–${fmt(f.p95)}</div></td>
              <td>${d ? `${signed(d.mean)}${Number.isFinite(d.pct) ? ` (${d.pct > 0 ? "+" : ""}${Math.round(d.pct)}%)` : ""}<div class="faint small">${signed(d.p5)} to ${signed(d.p95)}</div>` : "—"}</td>
              <td>${d ? pct(d.probHigher) : "—"}</td>
              ${evNames.map((n) => `<td>${pct(s.events[n].probability)}${Number.isFinite(s.events[n].medianFirstStep) ? `<div class="faint small">by ${esc(unit)} ${Math.round(s.events[n].medianFirstStep)}</div>` : ""}</td>`).join("")}</tr>`;
          }).join("")}</tbody></table></div>
        <div class="faint small">${r.runs.toLocaleString()} futures per scenario${r.capped ? " (lowered to fit the time limit)" : ""}, the same luck in each, so differences come from the change. Event columns: chance it happens at any point.</div>
        ${r.sensitivity ? `<h2 class="mt-sub">What moves ${esc(focus)} most</h2>${tornado(r.sensitivity.rows, focus)}` : ""}`;
    } catch (err) { $("#mt-err").textContent = err.message; }
    btn.disabled = false; btn.textContent = "Run";
  };
}

function splitBar(split) {
  if (!split) return "";
  return `<div class="split" title="For ${pct(split.for)} · Undecided ${pct(split.undecided)} · Against ${pct(split.against)}">
    <span class="for" data-w="${split.for}"></span><span class="und" data-w="${split.undecided}"></span><span class="ag" data-w="${split.against}"></span></div>`;
}
/** CSP blocks inline styles, so widths are applied from data attributes. */
function sizeBars(root) {
  root.querySelectorAll(".split [data-w]").forEach((el) => { el.style.flexGrow = String(Number(el.dataset.w) || 0.0001); });
}

async function renderConjure() {
  const data = await api("GET", "/api/conjure");
  main().innerHTML = `
    <div class="page narrow">
      <div class="page-head"><h1>CONJURE<sup class="tm">™</sup></h1><span class="faint small">Swarm forecasting</span></div>
      <p class="muted">Give CONJURE a question and some background. It builds the people involved as AI agents, lets them react to each other over several rounds, and writes a forecast. You can inject “what if” events, compare futures and interview any agent.</p>
      ${data.aiConnected ? "" : `<div class="notice">AI isn't connected yet, so simulations can't run. Set OMNIROUTE_API_KEY on the server.</div>`}
      <form id="new-sim" class="section">
        <label class="field">Question<input class="input" name="question" required maxlength="500" placeholder="Will the city approve the new transit budget this quarter?"></label>
        <label class="field">Background<textarea class="input" name="seed" rows="5" required maxlength="30000" placeholder="Paste news, a report or your notes. The more specific, the better."></textarea></label>
        <div class="grid2">
          <label class="field">Agents<select class="input" name="agents"><option>12</option><option selected>24</option><option>48</option><option>96</option></select></label>
          <label class="field">Rounds<select class="input" name="rounds"><option>3</option><option selected>5</option><option>8</option><option>12</option></select></label>
        </div>
        <p class="faint small" id="estimate"></p>
        <div class="error" id="sim-err"></div>
        <button class="btn primary" ${data.aiConnected ? "" : "disabled"}>Build simulation</button>
      </form>
      ${data.simulations.length ? `<div class="section"><h2>Simulations</h2><div class="list">${data.simulations.map((s) => `
        <a class="item" href="#/conjure/${esc(s.id)}"><div class="main"><div class="title">${esc(s.question)}</div>
        <div class="sub">${s.agents} agents · round ${s.round}/${s.rounds}${s.forkedFrom ? " · fork" : ""}${s.outcome ? ` · ${esc(s.outcome)} (${pct(s.probability)})` : ""}</div></div>
        ${splitBar(s.latest?.split)}</a>`).join("")}</div></div>` : ""}
    </div>`;
  sizeBars(main());
  const form = $("#new-sim");
  const est = async () => {
    try {
      const e = await api("GET", `/api/conjure/estimate?agents=${form.agents.value}&rounds=${form.rounds.value}`);
      $("#estimate").textContent = `About ${e.calls} AI calls in total. Rounds run one at a time, so you can stop whenever you like.`;
    } catch {}
  };
  form.agents.onchange = est; form.rounds.onchange = est; est();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button");
    btn.disabled = true; btn.textContent = "Building the world…";
    try {
      const sim = await api("POST", "/api/conjure", { question: form.question.value, seed: form.seed.value, agents: Number(form.agents.value), rounds: Number(form.rounds.value) });
      location.hash = `#/conjure/${sim.id}`;
    } catch (err) { $("#sim-err").textContent = err.message; btn.disabled = false; btn.textContent = "Build simulation"; }
  };
}

let simRunning = false;

async function renderSimulation(id) {
  const s = await api("GET", `/api/conjure/${encodeURIComponent(id)}`);
  const latest = s.stats.at(-1);
  const agents = [...s.personas].sort((a, b) => b.influence - a.influence);
  const r = s.report;
  main().innerHTML = `
    <div class="page narrow">
      <a class="faint small" href="#/conjure">← CONJURE</a>
      <div class="page-head"><h1 class="sim-q">${esc(s.question)}</h1></div>
      <p class="muted small">${s.personas.length} agents · round ${s.round} of ${s.rounds} · ${s.calls}/${s.maxCalls} AI calls${s.forkedFrom ? ` · forked from <a href="#/conjure/${esc(s.forkedFrom.id)}">another simulation</a> at round ${s.forkedFrom.round}` : ""}</p>
      ${stanceChart(s.stats, s.poles)}
      ${latest ? `<div class="split-row">${splitBar(latest.split)}<div class="faint small">For ${pct(latest.split.for)} · Undecided ${pct(latest.split.undecided)} · Against ${pct(latest.split.against)}</div></div>` : ""}
      <div class="sim-actions">
        ${s.status !== "done" ? `<button class="btn primary" id="step">Run next round</button><button class="btn" id="run-all">Run to the end</button>` : ""}
        ${s.round > 0 ? `<button class="btn" id="report">${r ? "Rewrite report" : "Write forecast"}</button>` : ""}
        <button class="btn" id="fork">Fork</button>
      </div>
      <div class="error" id="sim-err"></div>
      ${s.status !== "done" ? `<form id="inject" class="inject"><input class="input" name="text" maxlength="1000" placeholder="What if… (e.g. a competitor cuts prices by 20%)"><button class="btn small">Inject</button></form>
        ${s.injections.length ? `<p class="faint small">${s.injections.map((i) => `Round ${i.round}: ${esc(i.text)}`).join(" · ")}</p>` : ""}` : ""}
      ${r ? `<div class="section report"><h2>Forecast</h2>
        <p class="outcome">${esc(r.outcome)} <span class="faint">· ${pct(r.probability)} estimate · ${esc(r.confidence)} confidence</span></p>
        <p class="run-output">${esc(r.forecast)}</p>
        ${r.drivers.length ? `<h3>Drivers</h3><ul>${r.drivers.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
        ${r.signals.length ? `<h3>Signals to watch</h3><ul>${r.signals.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
        ${r.assumptions.length ? `<h3>Assumptions</h3><ul>${r.assumptions.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : ""}
        <p class="faint small">A simulation is evidence, not proof. The estimate is CONJURE's judgement from ${s.personas.length} simulated agents.</p></div>` : ""}
      <div class="section"><h2>Feed</h2>${s.feed.length ? `<div class="feed">${[...s.feed].reverse().slice(0, 60).map((x) => `
        <div class="post${x.authorId === "world" ? " news" : ""}"><div class="sub">${esc(x.author)} · round ${x.round}${x.replyTo ? " · reply" : ""}</div><div>${esc(x.text)}</div>
        ${x.authorId === "world" ? "" : `<div class="faint small">${x.likes} likes · ${x.reposts} reposts</div>`}</div>`).join("")}</div>` : `<p class="faint">Run a round to see the agents talk.</p>`}</div>
      <div class="section"><h2>Agents</h2><div class="list">${agents.map((p) => `
        <div class="item"><div class="main"><div class="title">${esc(p.name)}</div><div class="sub">${esc(p.role)} · influence ${p.influence}/5 · ${stanceLabel(p.stance)} (${p.stance})</div></div>
        <button class="btn small" data-interview="${esc(p.id)}">Interview</button></div>`).join("")}</div></div>
    </div>`;
  sizeBars(main());
  const err = $("#sim-err");
  const act = async (fn) => { err.textContent = ""; try { await fn(); } catch (e) { err.textContent = e.message; } };
  $("#step")?.addEventListener("click", (e) => act(async () => { e.target.disabled = true; e.target.textContent = "Agents are acting…"; await api("POST", `/api/conjure/${id}/step`, {}); renderSimulation(id); }));
  $("#run-all")?.addEventListener("click", (e) => act(async () => {
    if (simRunning) return;
    simRunning = true;
    e.target.textContent = "Running… (stops if you leave)";
    try {
      let cur = s;
      while (cur.status !== "done" && location.hash === `#/conjure/${id}`) {
        cur = await api("POST", `/api/conjure/${id}/step`, {});
        toast(`Round ${cur.round} of ${cur.rounds} done`);
      }
    } finally { simRunning = false; }
    if (location.hash === `#/conjure/${id}`) renderSimulation(id);
  }));
  $("#report")?.addEventListener("click", (e) => act(async () => { e.target.disabled = true; e.target.textContent = "Investigating…"; await api("POST", `/api/conjure/${id}/report`, {}); renderSimulation(id); }));
  $("#fork").onclick = () => act(async () => { const f = await api("POST", `/api/conjure/${id}/fork`, {}); toast("Forked. Inject a different event to compare."); location.hash = `#/conjure/${f.id}`; });
  const inj = $("#inject");
  if (inj) inj.onsubmit = (e) => { e.preventDefault(); act(async () => { await api("POST", `/api/conjure/${id}/inject`, { text: inj.text.value }); toast("Event added to the next round"); renderSimulation(id); }); };
  main().querySelectorAll("[data-interview]").forEach((b) => b.onclick = () => interviewModal(id, s.personas.find((p) => p.id === b.dataset.interview)));
}

function interviewModal(simId, p) {
  const history = [];
  modal(`<h2>${esc(p.name)}</h2><p class="faint small">${esc(p.role)} · simulated agent</p><div id="iv-log" class="iv-log"></div>
    <label class="field">Ask a question<input class="input" name="q" maxlength="1000" placeholder="What would change your mind?"></label>`, async (fd) => {
    const q = String(fd.get("q") || "").trim();
    if (!q) throw new Error("Ask something");
    const { answer } = await api("POST", `/api/conjure/${simId}/interview`, { agentId: p.id, question: q, history });
    history.push({ q, a: answer });
    $("#iv-log").innerHTML = history.map((h) => `<p><b>You:</b> ${esc(h.q)}</p><p>${esc(h.a)}</p>`).join("");
    $("#modal-form").q.value = "";
    throw new Error(""); // keep the dialog open for the next question
  });
  $("#m-ok").textContent = "Ask";
}
