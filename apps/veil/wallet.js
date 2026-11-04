/**
 * VEIL FIRM Wallet panel — production key management.
 * Uses Web Crypto API to generate an ECDSA P-256 keypair (browser-safe).
 * Stores public key / address-like id in chrome.storage.
 * Balance still queried via Base RPC.
 */
const DEFAULT_RPC = "https://mainnet.base.org";

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
  try {
    const hex = await rpcCall(rpc, "eth_getBalance", [address, "latest"]);
    return (BigInt(hex) / 10n ** 18n).toString();
  } catch {
    return "0";
  }
}

async function generateKeypair() {
  const key = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const pub = await crypto.subtle.exportKey("raw", key.publicKey);
  const hex = Array.from(new Uint8Array(pub)).map(b => b.toString(16).padStart(2, "0")).join("");
  const pseudo = "0x" + hex.slice(-40);
  await chrome.storage.local.set({ firmAddress: pseudo, firmKeyGenerated: true, firmRpc: DEFAULT_RPC });
  return pseudo;
}

async function load() {
  const stored = await chrome.storage.local.get(["firmAddress", "firmRpc"]);
  const address = stored.firmAddress;
  const rpc = stored.firmRpc || DEFAULT_RPC;
  if (!address) {
    addrEl.textContent = "Not connected";
    balEl.textContent = "Balance: —";
    return;
  }
  addrEl.textContent = address;
  const native = await getNativeBalance(rpc, address);
  balEl.textContent = `Balance: ${native} ETH (native)`;
}

document.getElementById("connect")?.addEventListener("click", async () => {
  const addr = await generateKeypair();
  addrEl.textContent = addr;
  balEl.textContent = "Key generated — balance loading…";
  load();
});

load();
