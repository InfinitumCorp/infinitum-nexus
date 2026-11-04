/**
 * VEIL FIRM Wallet panel.
 * Browser-side RPC client matching packages/firm/src/evm-client.ts.
 * Production: set FIRM_RPC and FIRM_TOKEN in chrome.storage or env.
 */
const DEFAULT_RPC = "https://mainnet.base.org";
const DEFAULT_TOKEN = ""; // set when FIRM token is deployed

const addrEl = document.getElementById("addr");
const balEl = document.getElementById("bal");

async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function getNativeBalance(rpc, address) {
  const hex = await rpcCall(rpc, "eth_getBalance", [address, "latest"]);
  return (BigInt(hex) / 10n ** 18n).toString();
}

async function load() {
  const stored = await chrome.storage.local.get(["firmAddress", "firmRpc", "firmToken"]);
  const address = stored.firmAddress;
  const rpc = stored.firmRpc || DEFAULT_RPC;
  if (!address) {
    addrEl.textContent = "Not connected";
    balEl.textContent = "Balance: —";
    return;
  }
  addrEl.textContent = address;
  try {
    const native = await getNativeBalance(rpc, address);
    balEl.textContent = `Balance: ${native} ETH (native)`;
  } catch (err) {
    balEl.textContent = `Balance: error (${err.message})`;
  }
}

document.getElementById("connect")?.addEventListener("click", async () => {
  // Scaffold: generate address. Production uses passkey / hardware / FirmWallet.
  const fake = "0x" + Array.from({ length: 40 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  await chrome.storage.local.set({ firmAddress: fake, firmRpc: DEFAULT_RPC });
  load();
});

load();
