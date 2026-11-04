/**
 * VEIL transaction sender.
 * Builds a claim payload, signs it, and prepares it for the RPC.
 * Scaffold: eth_sendRawTransaction still needs full RLP encoding.
 */
async function buildClaimTx(veilClaim, receiptId, amountWei) {
  const stored = await chrome.storage.local.get(["firmAddress", "firmRpc"]);
  const rpc = stored.firmRpc || "https://mainnet.base.org";
  const from = stored.firmAddress;
  const nonce = await rpcCall(rpc, "eth_getTransactionCount", [from, "latest"]);
  const gasPrice = await rpcCall(rpc, "eth_gasPrice", []);
  const data = encodeClaim(receiptId, amountWei);
  return {
    from,
    to: veilClaim,
    data,
    nonce,
    gasPrice,
    gas: "0x5208",
    value: "0x0",
    chainId: 8453, // Base
  };
}

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

async function sendClaim(veilClaim, amount) {
  const receiptId = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, "0")).join("");
  const amountWei = BigInt(Math.floor(parseFloat(amount) * 1e18));
  const tx = await buildClaimTx(veilClaim, receiptId, amountWei);
  const sig = await signClaim({ ...tx, receiptId });
  console.log("Signed claim tx", { tx, sig });
  return { tx, sig, receiptId };
}
