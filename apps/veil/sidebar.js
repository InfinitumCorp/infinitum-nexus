/**
 * VEIL sidebar. Renders state from the background worker and sends requests.
 * It holds no state of its own beyond what is on screen.
 */
import { ANONYMOUS, AUTHENTICATED, LABELS, can } from "./lib/workspace.js";
import { formatVeil, POLICY } from "./lib/rewards.js";
import { submitAsk } from "./lib/ask.js";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const say = (text) => { statusEl.textContent = text; };

async function send(type, extra = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...extra });
  if (r?.error) throw new Error(r.error);
  return r;
}

let state = null;

// ---------- Navigation & workspace gating ----------

function showPanel(id) {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.panel === id));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === id));
  if (id === "rewards") loadRewards();
}
document.querySelectorAll("nav button").forEach((b) => { b.onclick = () => showPanel(b.dataset.panel); });

function applyWorkspace() {
  const ws = state.workspace;
  const chip = $("ws-chip");
  chip.textContent = ws === ANONYMOUS ? "Anonymous" : "Signed in · not anonymous";
  chip.className = `chip ${ws === ANONYMOUS ? "anon" : "auth"}`;

  let activeHidden = false;
  document.querySelectorAll("nav button[data-cap]").forEach((b) => {
    b.hidden = !can(ws, b.dataset.cap);
    if (b.hidden && b.classList.contains("active")) activeHidden = true;
  });
  if (activeHidden) showPanel("privacy");

  $("ws-desc").textContent = ws === ANONYMOUS
    ? `${LABELS[ANONYMOUS]}: no account, AI, wallet, sync or rewards. Nothing links your browsing to you.`
    : `${LABELS[AUTHENTICATED]}: Cumulus://ID, Mail, the Infinitum apps, AI, FIRM Wallet and $VEIL rewards. Signed-in browsing is never anonymous.`;
  $("ws-switch").textContent = ws === ANONYMOUS ? "Switch to signed-in workspace" : "Switch to anonymous workspace";
  $("signin-card").hidden = !can(ws, "signin");
  $("cid-who").textContent = state.cidUser
    ? `Signed in as ${state.cidUser.username ?? state.cidUser.cid}${state.cidUser.mailAddress ? ` · ${state.cidUser.mailAddress}` : ""}`
    : "Not signed in";
  if (can(ws, "signin")) loadProviders();
}

// ---------- Workspace switch (two-step, in-panel confirmation) ----------

let pendingSwitch = null;
$("ws-switch").onclick = async () => {
  const to = state.workspace === ANONYMOUS ? AUTHENTICATED : ANONYMOUS;
  const r = await send("switchWorkspace", { to, confirmed: false });
  if (!r.plan) return;
  pendingSwitch = to;
  $("confirm-text").textContent = r.plan.warning;
  $("confirm").hidden = false;
};
$("confirm-no").onclick = () => { pendingSwitch = null; $("confirm").hidden = true; };
$("confirm-yes").onclick = async () => {
  if (!pendingSwitch) return;
  try {
    say("Clearing site data…");
    await send("switchWorkspace", { to: pendingSwitch, confirmed: true });
    say(`Now in the ${LABELS[pendingSwitch].toLowerCase()}`);
  } catch (err) {
    say(`Switch failed: ${err.message}`);
  }
  pendingSwitch = null;
  $("confirm").hidden = true;
  await refresh();
};

// ---------- Privacy ----------

function renderTor() {
  const status = state.tor?.status;
  const dot = $("tor-dot");
  dot.classList.toggle("on", status === "tor");
  dot.classList.toggle("bad", status === "unreachable" || status === "not-tor");
  const port = state.tor?.endpoint?.port ?? 9050;
  const labels = {
    tor: `Tor is up · socks5://127.0.0.1:${port}`,
    checking: "Checking Tor…",
    unreachable: "Tor unreachable — browser traffic blocked",
    "not-tor": "The check did not see a Tor exit — traffic stays blocked",
    off: "Tor off",
  };
  $("tor-status").textContent = labels[status] ?? (state.torEnabled ? "Tor on" : "Tor off");
  $("tor-toggle").textContent = state.torEnabled ? "Turn off Tor" : "Turn on Tor";
}
$("tor-toggle").onclick = async () => {
  try {
    await send("toggleTor", { enabled: !state.torEnabled });
    await refresh();
    say(state.torEnabled ? "Tor on. Use Check connection to confirm." : "Tor off");
  } catch (err) { say(`Tor: ${err.message}`); }
};
$("check-tor").onclick = async () => {
  say("Checking with check.torproject.org…");
  const r = await send("checkTor");
  say(r.isTor ? "Confirmed: this browser is exiting through Tor" : r.status === "unreachable" ? "Tor is unreachable. Traffic stays blocked." : `Not a Tor exit${r.error ? ` (${r.error})` : ""}`);
  await refresh();
};
$("new-circuit").onclick = async () => {
  try {
    const r = await send("newCircuit");
    say(`New circuit requested (isolation ${r.generation}). Tor must use IsolateSOCKSAuth.`);
  } catch (err) { say(err.message); }
};
$("auto-clean").onchange = (e) => send("setAutoClean", { enabled: e.target.checked });
$("clean-current").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: "cleanUrl" });
    say(r?.cleaned ? "Tracking parameters removed" : "No tracking parameters found");
  } catch { say("This page can't be cleaned"); }
};
let identityArmed = false;
$("new-identity").onclick = async () => {
  if (!identityArmed) {
    identityArmed = true;
    $("new-identity").textContent = "Click again to clear and close all tabs";
    setTimeout(() => { identityArmed = false; $("new-identity").textContent = "New Identity"; }, 5000);
    return;
  }
  identityArmed = false;
  $("new-identity").textContent = "New Identity";
  try { await send("newIdentity"); say("New Identity: site data cleared, tabs closed"); }
  catch (err) { say(`New Identity failed: ${err.message}`); }
};

// ---------- Ask ----------

$("ask-btn").onclick = async () => {
  if (!can(state.workspace, "ai")) return;
  const text = $("q").value.trim();
  if (!text) return;
  say("Thinking…");
  try {
    const page = $("include-page").checked
      ? await chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab ? { title: tab.title, url: tab.url } : null)
      : null;
    const result = await submitAsk({ origin: state.origins.architect, text, page });
    $("out").textContent = JSON.stringify(result, null, 2);
    say("Ready");
  } catch (err) {
    $("out").textContent = `:\\ARCHITECT\\™ unreachable at ${state.origins.architect}.\n${err.message}`;
    say(":\\ARCHITECT\\™ offline");
  }
};

// ---------- Rewards ----------

async function loadRewards() {
  if (!can(state?.workspace, "rewards")) return;
  const { summary, receipts } = await send("getRewards");
  $("r-today").textContent = `${formatVeil(summary.earnedTodayMicro)} $VEIL`;
  $("r-minutes").textContent = `${summary.eligibleMinutesToday} of ${POLICY.maxMinutesPerDay} rewarded minutes`;
  $("r-bar").style.width = `${(100 * summary.eligibleMinutesToday) / POLICY.maxMinutesPerDay}%`;
  $("r-pending").textContent = formatVeil(summary.pendingMicro);
  $("r-lifetime").textContent = formatVeil(summary.lifetimeMicro);
  $("r-limit").textContent = formatVeil(summary.dailyLimitMicro);
  $("r-receipts").textContent = String(summary.receipts);
  $("claim").disabled = summary.pendingMicro <= 0 || !state.cidUser;
  $("r-log").textContent = receipts.length
    ? receipts.map((r) => `${r.issuedAt.slice(0, 16).replace("T", " ")}  ${r.amount} $VEIL  ${r.status}`).join("\n")
    : state.cidUser ? "No receipts yet" : "Sign in with Cumulus://ID to claim";
}
$("claim").onclick = async () => {
  try {
    const { receipt } = await send("claimRewards");
    say(receipt ? `Receipt ${receipt.id} for ${receipt.amount} $VEIL` : "Nothing pending");
  } catch (err) { say(err.message); }
  loadRewards();
};

// ---------- Wallet ----------

function renderWallet() {
  const w = state.account?.wallet;
  $("w-addr").textContent = w?.address ?? "Not set up";
  const bal = $("w-bal");
  bal.replaceChildren();
  for (const [asset, amount] of Object.entries(w?.balances ?? {})) {
    const cell = document.createElement("div");
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = asset;
    const value = document.createElement("div");
    value.textContent = amount;
    cell.append(label, value);
    bal.append(cell);
  }
  const suite = $("w-suite");
  if (suite) suite.wallet = w ? { address: w.address, balances: w.balances } : null;
  $("w-note").textContent = w
    ? "The FIRM Wallet account that came with your Cumulus://ID. Self-custody keys on this device arrive with roadmap Phase IV."
    : "Sign in with Cumulus://ID to see the FIRM Wallet account that comes with it. VEIL never creates placeholder addresses or balances.";
}

// ---------- Apps (Nexus launcher) ----------

function renderApps() {
  const list = $("app-list");
  list.replaceChildren();
  for (const app of state.apps) {
    const btn = document.createElement("button");
    btn.className = "app";
    const text = document.createElement("div");
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = app.name;
    const blurb = document.createElement("div");
    blurb.className = "muted";
    blurb.textContent = app.blurb;
    text.append(name, blurb);
    btn.append(text);
    if (app.badge > 0) {
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = app.badge > 99 ? "99+" : String(app.badge);
      b.title = `${app.badge} unread`;
      btn.append(b);
    }
    if (app.panel) {
      btn.onclick = () => showPanel(app.panel);
    } else if (app.url) {
      btn.onclick = async () => {
        try { await send("openApp", { id: app.id }); } catch (err) { say(err.message); }
      };
    } else {
      btn.disabled = true;
      const soon = document.createElement("span");
      soon.className = "soon";
      soon.textContent = "Coming soon";
      btn.append(soon);
    }
    list.append(btn);
  }
}

function renderSummary() {
  const a = state.account;
  $("summary-card").hidden = !a;
  if (!a) return;
  $("s-plan").textContent = a.plan ?? "Free";
  $("s-unread").textContent = String(a.mail?.unread ?? 0);
  $("s-storage").textContent = a.storage?.label ?? "—";
  $("s-storage-bar").style.width = `${a.storage?.pct ?? 0}%`;
}

// ---------- Cumulus://ID ----------

let providersRun = 0;
async function loadProviders() {
  const run = ++providersRun; // a later call wins; earlier ones stop after their fetch
  const el = $("social-buttons");
  el.replaceChildren();
  if (state.cidUser) return;
  try {
    const r = await fetch(`${state.origins.cid}/api/auth/providers`, { credentials: "omit" });
    const providers = await r.json();
    if (run !== providersRun) return;
    if (!Array.isArray(providers) || !providers.length) {
      el.textContent = "No sign-in providers are configured on the CID origin.";
      return;
    }
    for (const p of providers) {
      const a = document.createElement("a");
      a.className = "provider";
      a.href = `${state.origins.cid}/api/auth/oauth/${encodeURIComponent(p.id)}/start`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = `Continue with ${p.label}`;
      el.append(a);
    }
  } catch {
    if (run === providersRun) el.textContent = `CID origin unreachable (${state.origins.cid}).`;
  }
}
$("cid-refresh").onclick = async () => {
  try {
    const { cidUser } = await send("refreshAccount");
    say(cidUser ? "Signed in" : "No CID session found. Finish signing in, then refresh.");
  } catch (err) { say(err.message); }
  await refresh();
};

// ---------- Boot ----------

async function refresh() {
  state = await send("getState");
  $("auto-clean").checked = state.autoClean;
  renderTor();
  renderWallet();
  renderApps();
  renderSummary();
  applyWorkspace();
  if ($("rewards").classList.contains("active")) loadRewards();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.rewardsLedger && $("rewards").classList.contains("active")) loadRewards();
  if (changes.workspace || changes.torEnabled || changes.cidUser || changes.account) refresh();
});

refresh().catch((err) => say(`VEIL background unavailable: ${err.message}`));
