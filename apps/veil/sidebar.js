/**
 * VEIL sidebar logic.
 * Multi-panel: Ask (Conductor), Wallet, Rewards, Privacy.
 */
const CONDUCTOR_URL = "http://localhost:3001";

const q = document.getElementById("q");
const out = document.getElementById("out");
const status = document.getElementById("status");
const addr = document.getElementById("addr");
const bal = document.getElementById("bal");
const veilBalance = document.getElementById("veil-balance");
const sessionTime = document.getElementById("session-time");
const rewardsLog = document.getElementById("rewards-log");
const torStatus = document.getElementById("tor-status");
const torDot = document.getElementById("tor-dot");

// Tab switching
document.querySelectorAll("nav button").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll("nav button").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.panel).classList.add("active");
  };
});

// Ask
document.getElementById("ask-btn").onclick = async () => {
  const text = q.value.trim();
  if (!text) return;
  status.textContent = "Thinking…";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const intent = `${text} (page: ${tab?.title ?? "unknown"} — ${tab?.url ?? ""})`;
    const r = await fetch(`${CONDUCTOR_URL}/api/perform`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent, autonomy: "rehearsal" }),
    });
    if (!r.ok) throw new Error(`Conductor ${r.status}`);
    const data = await r.json();
    out.textContent = JSON.stringify(data, null, 2);
    status.textContent = "Ready";
    accrueReward(5); // small reward for query
  } catch (err) {
    out.textContent = `Conductor unreachable. Local echo:\n${text}\n\n${String(err)}`;
    status.textContent = "Offline";
  }
};

// Wallet
async function loadWallet() {
  const stored = await chrome.storage.local.get(["firmAddress", "firmBalance"]);
  const address = stored.firmAddress ?? "0x" + "0".repeat(40);
  addr.textContent = address;
  bal.textContent = `Balance: ${stored.firmBalance ?? "0"} FIRM`;
}
document.getElementById("connect-wallet").onclick = async () => {
  const fakeAddr = "0x" + Math.random().toString(16).slice(2, 10).padEnd(40, "0");
  await chrome.storage.local.set({ firmAddress: fakeAddr, firmBalance: "42.0" });
  loadWallet();
  status.textContent = "Wallet connected (scaffold)";
};
loadWallet();

// Rewards
let sessionSeconds = 0;
let totalVeil = 0;
const RATE = 0.001;

async function loadRewards() {
  const stored = await chrome.storage.local.get(["totalVeil", "rewardLog"]);
  totalVeil = parseFloat(stored.totalVeil ?? "0");
  veilBalance.textContent = `${totalVeil.toFixed(6)} VEIL`;
  rewardsLog.textContent = (stored.rewardLog ?? []).slice(-5).map(e => `${e.at.slice(11,19)} +${e.veil}`).join("\n") || "No events yet";
}
function accrueReward(seconds) {
  const veil = (seconds * RATE).toFixed(6);
  totalVeil += parseFloat(veil);
  const event = { seconds, veil, at: new Date().toISOString() };
  chrome.storage.local.get(["rewardLog"], (s) => {
    const log = s.rewardLog ?? [];
    log.push(event);
    chrome.storage.local.set({ totalVeil: totalVeil.toString(), rewardLog: log.slice(-20) });
    loadRewards();
  });
}
setInterval(() => {
  sessionSeconds += 1;
  sessionTime.textContent = `Session: ${sessionSeconds}s`;
  if (sessionSeconds % 60 === 0) accrueReward(60);
}, 1000);
loadRewards();

// Privacy
document.getElementById("clean-current").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "cleanUrl" }, (resp) => {
    if (resp?.cleaned) status.textContent = "URL cleaned";
  });
};

const autoClean = document.getElementById("auto-clean");
if (autoClean) {
  chrome.storage.local.get(["autoClean"], (s) => { autoClean.checked = !!s.autoClean; });
  autoClean.onchange = () => {
    chrome.runtime.sendMessage({ type: "setAutoClean", enabled: autoClean.checked });
  };
}

const torToggle = document.getElementById("tor-toggle");
const checkTorBtn = document.getElementById("check-tor");
async function refreshTor() {
  const resp = await chrome.runtime.sendMessage({ type: "getTorStatus" });
  const enabled = resp?.enabled;
  torStatus.textContent = enabled
    ? "Tor proxy: ON (socks5://127.0.0.1:9050)"
    : "Tor proxy: OFF";
  torDot.classList.toggle("offline", !enabled);
  if (torToggle) torToggle.textContent = enabled ? "Disable Tor" : "Enable Tor";
}
if (torToggle) {
  torToggle.onclick = async () => {
    const current = !(await chrome.runtime.sendMessage({ type: "getTorStatus" }))?.enabled;
    await chrome.runtime.sendMessage({ type: "toggleTor", enabled: current });
    refreshTor();
    status.textContent = current ? "Tor enabled (needs local Tor)" : "Tor disabled";
  };
}
if (checkTorBtn) {
  checkTorBtn.onclick = async () => {
    status.textContent = "Checking Tor…";
    const resp = await chrome.runtime.sendMessage({ type: "checkTor" });
    status.textContent = resp?.isTor ? "Confirmed on Tor" : "Not on Tor (or check failed)";
  };
}
refreshTor();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") status.textContent = msg.text;
});
