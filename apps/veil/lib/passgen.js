/**
 * VEIL password generator. Reads per-site requirements written in the
 * password rules format (minlength, maxlength, required, allowed,
 * max-consecutive) and generates a random password that meets them, using
 * crypto.getRandomValues with rejection sampling (no modulo bias).
 *
 * Site rules come from lib/password-rules.js (MIT data, see
 * third_party/password-manager-resources). This parser and generator are
 * Infinitum Corporation's own code.
 */
import { PASSWORD_RULES } from "./password-rules.js";

const RANGE = (a, z) => Array.from({ length: z.charCodeAt(0) - a.charCodeAt(0) + 1 }, (_, i) => String.fromCharCode(a.charCodeAt(0) + i)).join("");

const BASE = {
  lower: RANGE("a", "z"),
  upper: RANGE("A", "Z"),
  digit: RANGE("0", "9"),
  // The format's "special" set, without the space character, which many sites trim.
  special: "-~!@#$%^&*_+=`|(){}[:;\"'<>,.?]",
};
const PRINTABLE = BASE.lower + BASE.upper + BASE.digit + BASE.special;
export const CLASSES = Object.freeze({ ...BASE, "ascii-printable": PRINTABLE, unicode: PRINTABLE });

export const DEFAULT_LENGTH = 20;

/** Parse one class list like "lower, upper, [-!@#]" into an array of char sets. */
function parseClasses(text) {
  const sets = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "," || /\s/.test(c)) { i++; continue; }
    if (c === "[") {
      let chars = "";
      i++;
      while (i < text.length) {
        if (text[i] === "]") {
          // A "]" inside a custom class must be written last, as "]]".
          if (text[i + 1] === "]") { chars += "]"; i += 2; }
          else i++;
          break;
        }
        chars += text[i++];
      }
      if (chars) sets.push([...new Set(chars)].join(""));
      continue;
    }
    const m = /^[a-z-]+/.exec(text.slice(i));
    if (!m) { i++; continue; }
    if (CLASSES[m[0]]) sets.push(CLASSES[m[0]]);
    i += m[0].length;
  }
  return sets;
}

/** Split on ";" outside custom classes. */
function properties(rule) {
  const out = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < rule.length; i++) {
    const c = rule[i];
    if (c === "[" && depth === 0) depth = 1;
    else if (c === "]" && depth === 1) {
      if (rule[i + 1] === "]") { cur += "]]"; i++; depth = 0; continue; }
      depth = 0;
    } else if (c === ";" && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * @returns {{ minLength: number|null, maxLength: number|null, maxConsecutive: number|null,
 *   required: string[], allowed: string }}
 */
export function parseRules(rule) {
  const parsed = { minLength: null, maxLength: null, maxConsecutive: null, required: [], allowed: "" };
  for (const prop of properties(String(rule ?? ""))) {
    const colon = prop.indexOf(":");
    if (colon < 0) continue;
    const name = prop.slice(0, colon).trim().toLowerCase();
    const value = prop.slice(colon + 1).trim();
    const n = Number.parseInt(value, 10);
    if (name === "minlength" && n > 0) parsed.minLength = Math.max(parsed.minLength ?? 0, n);
    else if (name === "maxlength" && n > 0) parsed.maxLength = Math.min(parsed.maxLength ?? Infinity, n);
    else if (name === "max-consecutive" && n > 0) parsed.maxConsecutive = Math.min(parsed.maxConsecutive ?? Infinity, n);
    else if (name === "required") {
      const sets = parseClasses(value);
      if (sets.length) parsed.required.push([...new Set(sets.join(""))].join(""));
    } else if (name === "allowed") {
      parsed.allowed = [...new Set(parsed.allowed + parseClasses(value).join(""))].join("");
    }
  }
  return parsed;
}

/** Rules for a host or its nearest listed parent domain. */
export function rulesFor(host, table = PASSWORD_RULES) {
  let h = String(host ?? "").toLowerCase().replace(/^www\./, "");
  while (h) {
    if (table[h]) return { host: h, rule: table[h] };
    const dot = h.indexOf(".");
    if (dot < 0) break;
    h = h.slice(dot + 1);
  }
  return null;
}

function randomIndex(n, random) {
  // Rejection sampling: draw 32-bit values below the largest multiple of n.
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    random(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/**
 * @param {string|null} rule password rules text (null for VEIL's default)
 * @param {{ length?: number, random?: (a: Uint32Array) => void }} [opts]
 */
export function generatePassword(rule, { length = DEFAULT_LENGTH, random = (a) => crypto.getRandomValues(a) } = {}) {
  const p = parseRules(rule);
  // Without explicit requirements, use one of each standard class, limited to what the site allows.
  const defaults = [CLASSES.lower, CLASSES.upper, CLASSES.digit, CLASSES.special]
    .map((set) => (p.allowed ? [...set].filter((c) => p.allowed.includes(c)).join("") : set))
    .filter(Boolean);
  const required = p.required.length ? p.required : defaults;
  const pool = [...new Set((p.allowed || "") + required.join(""))].join("") || CLASSES["ascii-printable"];
  const min = Math.max(p.minLength ?? 1, required.length);
  const max = p.maxLength ?? Infinity;
  const n = Math.max(min, Math.min(length, max));
  for (let attempt = 0; attempt < 1000; attempt++) {
    const chars = [];
    // One character from each required class, then fill from the pool.
    for (const set of required) chars.push(set[randomIndex(set.length, random)]);
    while (chars.length < n) chars.push(pool[randomIndex(pool.length, random)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomIndex(i + 1, random);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const password = chars.join("");
    if (meetsRules(password, p)) return password;
  }
  throw new Error("Could not satisfy this site's password rules");
}

export function meetsRules(password, parsed) {
  const p = typeof parsed === "string" ? parseRules(parsed) : parsed;
  if (p.minLength && password.length < p.minLength) return false;
  if (p.maxLength && password.length > p.maxLength) return false;
  for (const set of p.required) if (![...password].some((c) => set.includes(c))) return false;
  if (p.allowed) {
    const ok = p.allowed + p.required.join("");
    if (![...password].every((c) => ok.includes(c))) return false;
  }
  if (p.maxConsecutive) {
    let run = 1;
    for (let i = 1; i < password.length; i++) {
      run = password[i] === password[i - 1] ? run + 1 : 1;
      if (run > p.maxConsecutive) return false;
    }
  }
  return true;
}

/** Generate for a site, applying its published rules when there are any. */
export function generateFor(host, opts) {
  const found = rulesFor(host);
  return { password: generatePassword(found?.rule ?? null, opts), rulesFrom: found?.host ?? null, rule: found?.rule ?? null };
}
