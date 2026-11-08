/**
 * The encrypted vault. The recovery phrase is encrypted on the device with AES-256-GCM under a
 * key stretched from the person's password (PBKDF2-SHA256, 600,000 iterations, random salt),
 * using the browser's built-in WebCrypto. The plaintext phrase is never stored and never sent.
 * Infinitum never sees it and cannot recover it: the recovery phrase is the only backup.
 */
export interface SealedVault {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string; // base64
  iv: string; // base64
  data: string; // base64 AES-GCM ciphertext of the phrase
  createdAt: string;
}

export class VaultError extends Error {}

const ITERATIONS = 600_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFrom(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function checkPassword(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (/^(.)\1+$/.test(password)) return "Pick something harder to guess.";
  return null;
}

export async function seal(phrase: string, password: string, iterations = ITERATIONS): Promise<SealedVault> {
  const problem = checkPassword(password);
  if (problem) throw new VaultError(problem);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt, iterations);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(phrase)));
  return { v: 1, kdf: "PBKDF2-SHA256", iterations, salt: b64(salt), iv: b64(iv), data: b64(data), createdAt: new Date().toISOString() };
}

export async function unseal(vault: SealedVault, password: string): Promise<string> {
  const key = await keyFrom(password, unb64(vault.salt), vault.iterations);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(vault.iv) as BufferSource }, key, unb64(vault.data) as BufferSource);
    return dec.decode(plain);
  } catch {
    throw new VaultError("Wrong password.");
  }
}

/* ---------- Unlock with the device (passkey + WebAuthn PRF) ---------- */

/**
 * A second copy of the phrase, encrypted under a secret that only the device's authenticator can
 * produce, after a fingerprint, face or screen-lock check (WebAuthn "prf" extension). On phones the
 * authenticator lives in the secure hardware (TEE / Secure Enclave). There's no server: the
 * passkey is used only to unlock this device, and the password still works.
 */
export interface DeviceVault {
  v: 1;
  credentialId: string; // base64
  prfSalt: string; // base64, what the authenticator is asked to evaluate
  iv: string;
  data: string;
  createdAt: string;
}

async function keyFromSecret(secret: Uint8Array, prfSalt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", secret as BufferSource, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: prfSalt as BufferSource, info: enc.encode("firm-wallet device unlock v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealWithSecret(phrase: string, secret: Uint8Array, credentialId: Uint8Array, prfSalt: Uint8Array): Promise<DeviceVault> {
  if (secret.length < 32) throw new VaultError("This device didn't return a usable secret.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFromSecret(secret, prfSalt);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(phrase)));
  return { v: 1, credentialId: b64(credentialId), prfSalt: b64(prfSalt), iv: b64(iv), data: b64(data), createdAt: new Date().toISOString() };
}

export async function unsealWithSecret(vault: DeviceVault, secret: Uint8Array): Promise<string> {
  const key = await keyFromSecret(secret, unb64(vault.prfSalt));
  try {
    return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(vault.iv) as BufferSource }, key, unb64(vault.data) as BufferSource));
  } catch {
    throw new VaultError("This device couldn't unlock the wallet. Use your password.");
  }
}

export const deviceVaultIds = (v: DeviceVault) => ({ credentialId: unb64(v.credentialId), prfSalt: unb64(v.prfSalt) });

/* ---------- Storage (IndexedDB, device only) ---------- */

const DB = "firm-wallet";
const STORE = "kv";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function kvDelete(key: string): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export const loadVault = () => kvGet<SealedVault>("vault");
export const saveVault = (v: SealedVault) => kvSet("vault", v);
export const loadDeviceVault = () => kvGet<DeviceVault>("vault-device");
export const saveDeviceVault = (v: DeviceVault) => kvSet("vault-device", v);
export const removeDeviceVault = () => kvDelete("vault-device");
