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
