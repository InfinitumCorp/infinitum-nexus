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
  const veil = state.veil ?? { mode: "off", session: null, browserOnly: true, deviceWide: false };
  const dot = $("dot");
  dot.className = "dot";
  if (veil.mode === "connected") {
    dot.classList.add("on");
    $("status").textContent = "Protected in this browser";
  } else if (veil.mode === "fail-closed") {
    dot.classList.add("block");
    $("status").textContent = "Blocked — proxy down";
  } else {
    $("status").textContent = "Off";
  }
  const signedIn = state.workspace === "authenticated";
  const who = state.cidUser;
  const session = veil.session;
  $("who").textContent = !signedIn
    ? "The anonymous workspace has no VEIL proxy. Switch to the signed-in workspace in the sidebar. Signed-in browsing is not anonymous."
    : who
      ? `${who.username ?? who.cid}${session?.entitled ? " · VEIL plan active" : " · no VEIL entitlement"}`
      : "No Cumulus ID session yet.";
  const servers = session?.entitled ? session.servers ?? [] : [];
  const select = $("server");
  const previous = select.value || veil.server?.id || "";
  select.replaceChildren();
  if (!servers.length) {
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = session?.entitled ? "No exit servers configured" : "Sign in with a VEIL plan to choose a server";
    select.append(empty);
  }
  for (const server of servers) {
    const option = document.createElement("option");
    option.value = server.id;
    option.textContent = `${server.name} · ${server.region} · ${server.scheme === "socks5" ? "SOCKS5" : "HTTPS"}`;
    select.append(option);
  }
  if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
  const busy = veil.mode === "connected" || veil.mode === "fail-closed";
  $("toggle").textContent = busy ? "Disconnect" : "Connect";
  $("toggle").className = veil.mode === "fail-closed" ? "warn" : "";
  $("toggle").disabled = !signedIn || (!busy && (!session?.entitled || !select.value));
  select.disabled = busy || !servers.length;
  const serverName = veil.server ? `${veil.server.name} (${veil.server.host}:${veil.server.port})` : "No server selected";
  $("detail").textContent = veil.mode === "fail-closed"
    ? "Browser traffic is blocked so it does not leak onto the network. Reconnect from Connect after the plan is available, or disconnect to browse directly."
    : veil.mode === "connected"
      ? `${serverName}. DNS for these requests goes through the proxy. Coverage is this browser only.`
      : "Connect sends browser traffic through the selected exit. It does not install a device-wide VPN.";
  $("sidebar").hidden = !chrome.sidePanel?.open;
}

async function refresh() {
  state = await send("getState");
  if (state.workspace === "authenticated") {
    try {
      const veil = await send("refreshVeil");
      state.veil = { ...state.veil, ...veil.veil, session: veil.session };
    } catch (err) {
      say(err.message);
    }
  }
  render();
}

$("signin").onclick = async () => {
  const url = state?.origins?.cid;
  if (!url) return;
  await chrome.tabs.create({ url });
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

$("toggle").onclick = async () => {
  say("");
  try {
    const veil = state.veil ?? { mode: "off" };
    if (veil.mode === "off") await send("connectVeil", { serverId: $("server").value });
    else await send("disconnectVeil");
    await refresh();
  } catch (err) {
    say(err.message);
    await refresh().catch(() => {});
  }
};

$("sidebar").onclick = async () => {
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
};

refresh().catch((err) => say(err.message));
