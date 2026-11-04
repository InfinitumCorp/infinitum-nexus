/**
 * VEIL signing helper.
 * Signs a claim payload with the stored Web Crypto key.
 * Production: use this signature in a VeilClaim.claim call.
 */
async function signClaim(payload) {
  const stored = await chrome.storage.local.get(["firmKey"]);
  if (!stored.firmKey) throw new Error("No key generated");
  const key = await crypto.subtle.importKey(
    "jwk",
    stored.firmKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function exportAndStoreKey(keyPair) {
  const jwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  await chrome.storage.local.set({ firmKey: jwk });
}
