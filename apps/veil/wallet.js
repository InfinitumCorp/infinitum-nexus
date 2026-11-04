/**
 * VEIL FIRM Wallet panel.
 * Uses chrome.storage. Production should wire to packages/firm.
 */
const addr = document.getElementById("addr");
const bal = document.getElementById("bal");

async function load() {
  const stored = await chrome.storage.local.get(["firmAddress", "firmBalance"]);
  addr.textContent = stored.firmAddress ?? "Not connected";
  bal.textContent = `Balance: ${stored.firmBalance ?? "0"} FIRM`;
}

document.getElementById("connect")?.addEventListener("click", async () => {
  // Scaffold connect — replace with real wallet flow
  const fake = "0x" + Array.from({length: 40}, () => Math.floor(Math.random()*16).toString(16)).join("");
  await chrome.storage.local.set({ firmAddress: fake, firmBalance: "42.0" });
  load();
});

load();
