const $ = (id) => document.getElementById(id);

async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...extra });
  if (response?.error) throw new Error(response.error);
  return response;
}

let state = null;

function say(text) {
  $("error").textContent = text ?? "";
}

function render() {
  const route = state.route ?? state.tor ?? { mode: "off", status: "off", defaultMode: "veil" };
  const mode = route.mode === "tor" || route.mode === "veil" ? route.mode : "off";
  for (const name of ["veil", "tor", "off"]) {
    $("mode-" + name).classList.toggle("active", mode === name);
  }
  const dot = $("dot");
  dot.className = "dot";
  const labels = {
    veil: "VEIL VPN — this browser is using the entitled exit",
    tor: route.status === "tor" ? "Tor — this browser is exiting through Tor" : "Tor — waiting for the local client",
    checking: "Checking Tor…",
    unreachable: "Route unreachable — traffic blocked",
    "not-tor": "Not a Tor exit — traffic stays blocked",
    off: "Off",
  };
  const key = route.status === "unreachable" || route.status === "not-tor" || route.status === "checking" ? route.status : mode;
  $("status").textContent = labels[key] ?? "Off";
  if (mode === "veil" || route.status === "tor") dot.classList.add("on");
  else if (route.status === "unreachable" || route.status === "not-tor") dot.classList.add("block");
  else if (route.status === "checking") dot.classList.add("warn");

  const session = route.session;
  const servers = session?.entitled ? session.servers ?? [] : [];
  const select = $("server");
  const previous = select.value || route.server?.id || "";
  select.replaceChildren();
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = session?.entitled ? "No exits configured" : "Sign in with a VEIL plan";
  if (!servers.length) select.append(empty);
  for (const server of servers) {
    const option = document.createElement("option");
    option.value = server.id;
    option.textContent = `${server.name} · ${server.region} · ${server.scheme === "socks5" ? "SOCKS5" : "HTTPS"}`;
    select.append(option);
  }
  if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
  select.disabled = mode === "veil";
  const signedIn = state.workspace === "authenticated";
  const who = state.cidUser;
  $("who").textContent = !signedIn
    ? "VEIL VPN needs the signed-in workspace and a VEIL plan. Tor does not. Signed-in browsing is not anonymous."
    : who
      ? `${who.username ?? who.cid}${session?.entitled ? " · VEIL plan active" : " · no VEIL entitlement"}`
      : "No Cumulus ID session yet.";
  $("endpoint").value = String(route.endpoint?.port) === "9150" ? "9150" : "9050";
  $("endpoint").disabled = mode === "tor";
  const detail = {
    veil: `${route.server?.name ?? "Exit"} · DNS goes through the proxy. WebRTC non-proxied UDP is off.`,
    tor: `SOCKS5 127.0.0.1:${route.endpoint?.port ?? 9050}. DNS and .onion names go through Tor. WebRTC non-proxied UDP is off.`,
    unreachable: "The selected route did not answer. Requests are not sent on the ordinary network.",
    off: "VEIL VPN is the default. Tor is optional and stays on this machine.",
  };
  $("detail").textContent = detail[route.status] ?? detail[mode] ?? detail.off;
  $("sidebar").hidden = !chrome.sidePanel?.open;
}

async function refresh() {
  state = await send("getState");
  if (state.workspace === "authenticated") {
    try {
      const premium = await send("refreshVeil");
      state.route = { ...state.route, ...premium.route, session: premium.session, bridges: premium.bridges };
    } catch (err) {
      say(err.message);
    }
  }
  render();
}

$("mode-off").onclick = async () => {
  say("");
  try {
    await send("disconnectVeil");
    await refresh();
  } catch (err) {
    say(err.message);
  }
};

$("mode-veil").onclick = async () => {
  say("");
  try {
    await send("connectVeil", { serverId: $("server").value });
    await refresh();
  } catch (err) {
    say(err.message);
    await refresh().catch(() => {});
  }
};

$("mode-tor").onclick = async () => {
  say("");
  try {
    await send("toggleTor", { enabled: true, port: Number($("endpoint").value) });
    const check = await send("checkTor");
    say(check.isTor ? "Connected through Tor." : check.status === "unreachable" ? "Tor is not reachable. Traffic is blocked." : "The check did not confirm a Tor exit.");
    await refresh();
  } catch (err) {
    say(err.message);
    await refresh().catch(() => {});
  }
};

$("check").onclick = async () => {
  say("");
  try {
    const check = await send("checkTor");
    say(check.isTor ? "Connected: this browser is using Tor." : check.status === "off" ? "Choose Tor first." : "Not confirmed as Tor. Traffic stays blocked.");
    await refresh();
  } catch (err) {
    say(err.message);
  }
};

$("circuit").onclick = async () => {
  say("");
  try {
    const result = await send("newCircuit");
    say(`New SOCKS isolation ${result.generation}. The local Tor client needs IsolateSOCKSAuth.`);
  } catch (err) {
    say(err.message);
  }
};

$("signin").onclick = async () => {
  const url = state?.origins?.cid;
  if (url) await chrome.tabs.create({ url });
};

$("refresh").onclick = async () => {
  say("");
  try {
    if (state?.workspace === "authenticated") await send("refreshAccount");
    await refresh();
  } catch (err) {
    say(err.message);
  }
};

$("sidebar").onclick = async () => {
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
};

// ---------- Protected status ----------

let protection = null;

function el(tag, attrs = {}, text = "") {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text) node.textContent = text;
  return node;
}

function renderProtection() {
  const p = protection;
  $("count-blocked").textContent = String(p.blocked);
  $("count-stripped").textContent = String(p.stripped);
  $("shield-host").textContent = p.host;
  $("blocking").checked = p.blockingEnabled;
  $("statement").textContent = p.statement;
  const problems = p.issues.length + p.downloads.length;
  $("shield-title").textContent = problems ? "Needs attention" : p.blockingEnabled ? "Protected" : "Blocking is off";
  $("shield-title").style.color = problems ? "var(--bad)" : p.blockingEnabled ? "var(--good)" : "var(--warn)";
  const issues = $("issues");
  issues.replaceChildren();
  for (const issue of p.issues) {
    const box = el("div", { class: "issue" });
    box.append(el("b", {}, issue.title), el("div", { class: "muted" }, issue.detail));
    const row = el("div", { class: "row" });
    for (const fix of issue.fixes) {
      const b = el("button", { type: "button", class: "ghost" }, fix.label);
      b.onclick = async () => {
        try { await send("fixIssue", { tabId: p.tabId, action: fix.action, url: fix.url }); window.close(); } catch (err) { say(err.message); }
      };
      row.append(b);
    }
    box.append(row);
    issues.append(box);
  }
  const downloads = $("downloads");
  downloads.replaceChildren();
  for (const d of p.downloads) {
    const box = el("div", { class: "issue" });
    box.append(el("b", {}, `Download paused: ${d.name}`));
    for (const r of d.reasons) box.append(el("div", { class: "muted" }, r.detail));
    const row = el("div", { class: "row" });
    const keep = el("button", { type: "button", class: "ghost" }, "Keep it");
    const cancel = el("button", { type: "button" }, "Cancel download");
    keep.onclick = () => send("downloadDecision", { id: d.id, keep: true }).then(loadProtection).catch((e) => say(e.message));
    cancel.onclick = () => send("downloadDecision", { id: d.id, keep: false }).then(loadProtection).catch((e) => say(e.message));
    row.append(cancel, keep);
    box.append(row);
    downloads.append(box);
  }
}

async function loadProtection() {
  protection = await send("getProtection");
  renderProtection();
}

$("blocking").onchange = async () => {
  try { await send("setBlocking", { enabled: $("blocking").checked }); await loadProtection(); } catch (err) { say(err.message); }
};

// ---------- Passwords ----------

let generated = "";

$("gen").onclick = async () => {
  say("");
  try {
    const result = await send("generatePassword", { host: protection?.host ?? "" });
    generated = result.password;
    $("gen-pass").textContent = generated;
    $("gen-rule").textContent = result.rulesFrom ? `Follows ${result.rulesFrom}'s password rules.` : "20 characters: letters, digits and symbols.";
    $("gen-out").hidden = false;
  } catch (err) {
    say(err.message);
  }
};

$("gen-copy").onclick = async () => {
  await navigator.clipboard.writeText(generated).then(() => say("Copied."), () => say("Couldn't copy."));
};

$("gen-fill").onclick = async () => {
  try {
    const r = await send("fillPassword", { tabId: protection?.tabId, value: generated });
    say(r?.filled ? `Filled ${r.filled} password field${r.filled > 1 ? "s" : ""}.` : "No password field on this page.");
  } catch {
    say("This page can't be filled.");
  }
};

function renderProtected(list) {
  const box = $("pw-list");
  box.replaceChildren();
  for (const entry of list) {
    const row = el("div", { class: "row" });
    row.append(el("span", {}, `${"•".repeat(Math.min(entry.length, 12))} on ${entry.hosts.join(", ")}`));
    const remove = el("button", { type: "button", class: "ghost" }, "Remove");
    remove.onclick = () => send("removeProtected", { id: entry.id }).then((r) => renderProtected(r.protected)).catch((e) => say(e.message));
    row.append(remove);
    box.append(row);
  }
}

$("pw-add").onclick = async () => {
  say("");
  try {
    const hosts = $("pw-hosts").value.split(/[\s,]+/).filter(Boolean);
    const r = await send("protectPassword", { password: $("pw-value").value, hosts });
    $("pw-value").value = "";
    renderProtected(r.protected);
    say("Protected. VEIL will warn you if it's typed anywhere else.");
  } catch (err) {
    say(err.message);
  }
};

loadProtection().then(() => { if (!$("pw-hosts").value) $("pw-hosts").value = protection.host.replace(/^www\./, ""); }).catch((err) => say(err.message));
send("listProtected").then((r) => renderProtected(r.protected)).catch(() => {});
refresh().catch((err) => say(err.message));
