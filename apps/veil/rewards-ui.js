/**
 * VEIL rewards panel helpers.
 * Local accrual + claim UI wiring for VeilClaim.
 */
const RATE = 0.001;

async function loadRewards() {
  const stored = await chrome.storage.local.get(["totalVeil", "rewardLog", "veilClaim"]);
  const total = parseFloat(stored.totalVeil ?? "0");
  document.getElementById("veil-balance").textContent = `${total.toFixed(6)} VEIL`;
  const log = stored.rewardLog ?? [];
  document.getElementById("rewards-log").textContent =
    log.slice(-5).map(e => `${e.at.slice(11,19)} +${e.veil}`).join("\n") || "No events yet";
  const claimBtn = document.getElementById("claim-btn");
  if (claimBtn) claimBtn.disabled = total <= 0 || !stored.veilClaim;
}

function accrue(seconds) {
  const veil = (seconds * RATE).toFixed(6);
  chrome.storage.local.get(["totalVeil", "rewardLog"], (s) => {
    const total = parseFloat(s.totalVeil ?? "0") + parseFloat(veil);
    const log = s.rewardLog ?? [];
    log.push({ seconds, veil, at: new Date().toISOString() });
    chrome.storage.local.set({ totalVeil: total.toString(), rewardLog: log.slice(-20) });
    loadRewards();
  });
}

document.getElementById("claim-btn")?.addEventListener("click", async () => {
  const stored = await chrome.storage.local.get(["totalVeil", "veilClaim", "firmAddress"]);
  if (!stored.veilClaim) {
    alert("Set veilClaim contract address in storage first");
    return;
  }
  try {
    const result = await sendClaim(stored.veilClaim, stored.totalVeil);
    alert(`Claim prepared. Receipt: ${result.receiptId}\nSignature: ${result.sig.slice(0, 16)}…`);
  } catch (err) {
    alert("Claim failed: " + err.message);
  }
});

setInterval(() => {
  const el = document.getElementById("session-time");
  if (el) {
    const sec = parseInt(el.textContent.replace(/\D/g, "") || "0", 10) + 1;
    el.textContent = `Session: ${sec}s`;
    if (sec % 60 === 0) accrue(60);
  }
}, 1000);

loadRewards();
