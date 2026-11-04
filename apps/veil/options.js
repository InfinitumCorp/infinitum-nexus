const rpcEl = document.getElementById("rpc");
const claimEl = document.getElementById("claim");
const msg = document.getElementById("msg");

async function load() {
  const s = await chrome.storage.local.get(["firmRpc", "veilClaim"]);
  rpcEl.value = s.firmRpc || "https://mainnet.base.org";
  claimEl.value = s.veilClaim || "";
}

document.getElementById("save").onclick = async () => {
  await chrome.storage.local.set({
    firmRpc: rpcEl.value.trim() || "https://mainnet.base.org",
    veilClaim: claimEl.value.trim() || ""
  });
  msg.textContent = "Saved.";
  setTimeout(() => { msg.textContent = ""; }, 2000);
};

load();
