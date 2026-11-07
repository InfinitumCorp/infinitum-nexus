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
  const tor = state.tor ?? { status: "off", mode: "off", endpoint: { port: 9050 } };
  const dot = $("dot");
  dot.className = "dot";
  const copy = {
    tor: "Tor — this browser is exiting through Tor",
    checking: "Checking the Tor exit…",
    unreachable: "Tor unreachable — traffic blocked",
    "not-tor": "Not a Tor exit — traffic stays blocked",
    booting: "Starting — traffic blocked",
    off: "Tor off",
  };
  $("status").textContent = copy[tor.status] ?? "Tor off";
  if (tor.status === "tor") dot.classList.add("on");
  else if (tor.status === "unreachable" || tor.status === "not-tor") dot.classList.add("block");
  else if (tor.status === "checking" || tor.status === "booting") dot.classList.add("warn");
  const on = state.torEnabled === true || tor.mode === "on";
  $("toggle").textContent = on ? "Turn Tor off" : "Use Tor";
  $("toggle").className = tor.status === "unreachable" ? "warn" : "";
  $("endpoint").value = String(tor.endpoint?.port) === "9150" ? "9150" : "9050";
  $("endpoint").disabled = on;
  const lines = {
    tor: `SOCKS5 127.0.0.1:${tor.endpoint?.port}. DNS and .onion names go through Tor. Circuits are isolated with SOCKS authentication.`,
    checking: "The proxy is on. Confirming the exit with check.torproject.org.",
    unreachable: "The local Tor client did not answer. Requests are not sent on the normal network.",
    "not-tor": "Something answered, and it was not Tor. The browser stays pointed at the local Tor port.",
    off: "Choose the local Tor you already run. VEIL does not download or start Tor.",
  };
  $("detail").textContent = lines[tor.status] ?? lines.off;
  const signedIn = state.workspace === "authenticated";
  const who = state.cidUser;
  const entitled = tor.session?.entitled === true;
  $("who").textContent = !signedIn
    ? "Anonymous workspace. Tor does not need Cumulus ID. Signed-in browsing is a separate choice and is not anonymous."
    : who
      ? `${who.username ?? who.cid}${entitled ? " · VEIL plan can load optional bridges" : " · no VEIL bridge plan"}`
      : "Signed-in workspace, no Cumulus ID session yet.";
  const bridges = entitled && Array.isArray(tor.bridges) ? tor.bridges : [];
  $("bridges").hidden = bridges.length === 0;
  $("bridges").textContent = bridges.join("\n");
  $("sidebar").hidden = !chrome.sidePanel?.open;
}

async function refresh() {
  state = await send("getState");
  if (state.workspace === "authenticated") {
    try {
      const premium = await send("refreshVeil");
      state.tor = { ...state.tor, ...premium.tor, session: premium.session, bridges: premium.bridges };
    } catch (err) {
      say(err.message);
    }
  }
  render();
}

$("endpoint").onchange = () => {};

$("toggle").onclick = async () => {
  say("");
  try {
    const on = state?.torEnabled === true || state?.tor?.mode === "on";
    await send("toggleTor", { enabled: !on, port: Number($("endpoint").value) });
    if (!on) {
      const check = await send("checkTor");
      say(check.isTor ? "Tor check succeeded." : check.status === "unreachable" ? "Tor is not reachable. Traffic is blocked." : "The check did not confirm a Tor exit.");
    }
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
    say(check.isTor ? "check.torproject.org says this browser is using Tor." : check.status === "off" ? "Turn Tor on first." : "Not confirmed as Tor. Traffic stays on the local Tor port.");
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
