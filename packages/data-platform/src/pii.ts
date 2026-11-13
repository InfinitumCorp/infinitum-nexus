// © Infinitum Corporation®. All rights reserved.
/**
 * Personal-data detection for string payload values, after the recognizer approach of
 * Microsoft Presidio (pattern recognizers plus validators to cut false positives).
 *
 * Contracts already forbid content fields by name. This catches personal data that slips
 * into an allowed field by value, e.g. an email address typed into a `tool` name. The
 * gateway rejects such events rather than storing them; `redact` exists for exports.
 */

export type PiiKind = "email" | "phone" | "credit_card" | "us_ssn" | "iban" | "ip_address" | "crypto_wallet";

export interface PiiFinding {
  kind: PiiKind;
  start: number;
  end: number;
}

interface Recognizer {
  kind: PiiKind;
  re: RegExp;
  validate?: (m: string) => boolean;
}

function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

function ibanOk(s: string): boolean {
  const v = s.replace(/\s/g, "").toUpperCase();
  if (v.length < 15 || v.length > 34) return false;
  const moved = v.slice(4) + v.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of code) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

function ipv4Ok(s: string): boolean {
  return s.split(".").every((p) => Number(p) <= 255 && String(Number(p)) === p);
}

const RECOGNIZERS: Recognizer[] = [
  { kind: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { kind: "credit_card", re: /\b(?:\d[ -]?){12,18}\d\b/g, validate: luhn },
  { kind: "us_ssn", re: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, validate: ibanOk },
  { kind: "ip_address", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, validate: ipv4Ok },
  { kind: "ip_address", re: /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g },
  { kind: "crypto_wallet", re: /\b(?:0x[a-fA-F0-9]{40}|bc1[a-z0-9]{25,59}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/g },
  { kind: "phone", re: /(?<![\w.])\+?\d{1,3}[ .-]?\(?\d{2,4}\)?[ .-]?\d{3}[ .-]?\d{2,4}(?:[ .-]?\d{2})?(?![\w.])/g },
];

export function detectPii(value: string): PiiFinding[] {
  const out: PiiFinding[] = [];
  for (const r of RECOGNIZERS) {
    r.re.lastIndex = 0;
    for (const m of value.matchAll(r.re)) {
      if (r.validate && !r.validate(m[0])) continue;
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (out.some((f) => start < f.end && end > f.start)) continue; // earlier recognizers win overlaps
      out.push({ kind: r.kind, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Replaces each finding with `<KIND>`. */
export function redact(value: string): string {
  const findings = detectPii(value);
  let out = "";
  let at = 0;
  for (const f of findings) {
    out += value.slice(at, f.start) + `<${f.kind.toUpperCase()}>`;
    at = f.end;
  }
  return out + value.slice(at);
}
