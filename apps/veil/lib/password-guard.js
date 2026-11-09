/**
 * VEIL password-reuse warning.
 *
 * The user marks a password as protected and lists the sites it belongs
 * to. VEIL keeps only a random salt, a PBKDF2-SHA-256 hash and the length,
 * in this browser. When the same password is typed on any other site, the
 * page gets a warning. The password itself is never stored, logged or sent
 * anywhere.
 *
 * Design inspired by phishcatch (Apache-2.0) and its approach of checking
 * typed passwords against salted local hashes. No phishcatch code is used.
 */

export const ITERATIONS = 150_000;
const SALT_BYTES = 16;

const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function normalizeHost(host) {
  return String(host ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "").replace(/\.$/, "");
}

/** a.example.com belongs to example.com; example.com does not belong to a.example.com. */
export function hostMatches(host, site) {
  const h = normalizeHost(host);
  const s = normalizeHost(site);
  return !!s && (h === s || h.endsWith(`.${s}`));
}

async function derive(password, salt, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}

/** @returns {Promise<{id: string, salt: string, hash: string, length: number, hosts: string[], iterations: number}>} */
export async function protect(password, hosts, { iterations = ITERATIONS } = {}) {
  if (typeof password !== "string" || password.length < 6) throw new Error("Use a password of at least 6 characters");
  const list = [...new Set((hosts ?? []).map(normalizeHost).filter(Boolean))];
  if (!list.length) throw new Error("Add at least one site where this password belongs");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return { id: b64(crypto.getRandomValues(new Uint8Array(9))), salt: b64(salt), hash: b64(hash), length: password.length, hosts: list, iterations };
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Entries whose length could match; lets callers skip hashing most input. */
export function candidates(entries, length) {
  return (entries ?? []).filter((e) => e.length === length);
}

/**
 * @returns {Promise<{ reused: boolean, id?: string, hosts?: string[] }>}
 *   reused is true only when the password matches an entry and host is not one of its sites.
 */
export async function check(entries, password, host) {
  for (const entry of candidates(entries, String(password ?? "").length)) {
    const hash = new Uint8Array(await derive(password, unb64(entry.salt), entry.iterations ?? ITERATIONS));
    if (!equal(hash, unb64(entry.hash))) continue;
    if (entry.hosts.some((site) => hostMatches(host, site))) return { reused: false, id: entry.id };
    return { reused: true, id: entry.id, hosts: entry.hosts };
  }
  return { reused: false };
}

export function trust(entries, id, host) {
  const h = normalizeHost(host);
  return (entries ?? []).map((e) => (e.id === id && h && !e.hosts.includes(h) ? { ...e, hosts: [...e.hosts, h] } : e));
}

/** What the popup may show: never the hash or salt. */
export function publicView(entries) {
  return (entries ?? []).map((e) => ({ id: e.id, hosts: e.hosts, length: e.length }));
}
