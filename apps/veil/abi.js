/**
 * Minimal ABI helpers for VeilClaim.
 * Production would use ethers/viem; this is a self-contained scaffold.
 */
const SELECTORS = {
  claim: "0x4e71d92d", // claim(bytes32,uint256) — placeholder
  claimWithSig: "0x12345678" // placeholder — replace with real selector after compile
};

function pad32(hex) {
  return hex.replace(/^0x/, "").padStart(64, "0");
}

function encodeClaim(receiptId, amountWei) {
  const rid = pad32(receiptId);
  const amt = pad32(amountWei.toString(16));
  return SELECTORS.claim + rid + amt;
}

function encodeClaimWithSig(receiptId, amountWei, sigHex) {
  const rid = pad32(receiptId);
  const amt = pad32(amountWei.toString(16));
  const sig = sigHex.replace(/^0x/, "");
  // dynamic bytes scaffold — real encoding would include offset + length
  return SELECTORS.claimWithSig + rid + amt + pad32((sig.length / 2).toString(16)) + sig;
}
