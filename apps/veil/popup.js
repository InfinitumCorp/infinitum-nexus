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
    say(check.isTor ? "Tor check succeeded." : check.status === "unreachable" ? "Tor is not reachable. Traffic is blocked." : "The check did not confirm a Tor exit.");
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
    say(check.isTor ? "check.torproject.org says this browser is using Tor." : check.status === "off" ? "Choose Tor first." : "Not confirmed as Tor. Traffic stays blocked.");
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

refresh().catch((err) => say(err.message));
