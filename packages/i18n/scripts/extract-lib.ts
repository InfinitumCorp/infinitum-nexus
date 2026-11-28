// String extraction for extract.ts (tested in extract-lib.test.ts).

const UI_ATTRS = /\b(placeholder|title|aria-label|alt|label|aria-description|data-tooltip)\s*=\s*(["'])([^"']*?)\2/g;

/** Does this read like user-facing copy rather than code, a class list, an id or a URL? */
export function isUiText(raw: string, lenient = false): boolean {
  const s = raw.trim();
  // "1 open deal": the singular half of `n === 1 ? "1 open deal" : `${n} open deals``.
  const countOfOne = /^1 \p{L}{2,}/u.test(s) && !/\b(auto|solid|dashed|dotted|none|normal|inherit|initial|span|fr)\b/.test(s);
  const prose = lenient || countOfOne || /\{\d+\}/.test(s);
  if (s.length < 2 || s.length > 400) return false;
  if (!/[A-Za-z]/.test(s.replace(/\{\d+\}/g, ""))) return false;
  if (/^(https?:|mailto:|data:|\.{0,2}\/|#|\.[a-z]|\[|@media|var\(|--)/i.test(s)) return false;
  if (/[;{}]\s*$|=>|\bfunction\b|\breturn\b|===|!==|&&|\|\||\bconst\b|\bimport\b|\bexport\b/.test(s.replace(/\{\d+\}/g, ""))) return false;
  if (/^[\w$.-]+\(.*\)$/.test(s)) return false;                 // call-like
  if (/^\(.*:|^['")\]]|\.replace\(|\/g\b|[a-z]-\{\d+\}/.test(s)) return false; // media queries, regex/code fragments, class-{0}
  if (/[{}]/.test(s.replace(/\{\d+\}/g, "")) || /\$$|\(\s*$|^[,:]\s/.test(s)) return false; // JSX/template code: {x ? (, `${`, ", body: f("
  if (/[\w\]]\[[\w-]+[\]=]|(^|\s)[a-z0-9-]+:[a-z[]|\w-\[|^(interface|class|type|enum|finally|Bearer)\b/.test(s)) return false; // tailwind lg:x / tracking-[..], TS keywords, auth headers
  if (/^[MmLlHhVvCcZz]\s*-?\d/.test(s) && /\d[\s,]+-?\d/.test(s)) return false; // SVG path data
  if (/^;|^(s|t|ve|re|ll|d|m)\s|\bundefined\b|\bnew [A-Z]\w*\(/.test(s)) return false; // JSX apostrophe fragments ("can't" -> "t ..."), code
  if (/^(\d{3}\s+)?\d+(\.\d+)?(px|em|rem|pt)\b/.test(s)) return false;  // canvas/CSS font shorthand: 10px ui-monospace, …
  if (/^[\w-]+=[^\s]+,/.test(s)) return false;                   // meta content: width=device-width, …
  if (/^[a-z][\w-]*:[^\s]/i.test(s) && !/\s/.test(s)) return false; // scheme:thing, key:value
  if (/\b[\w-]+\s*:\s*[^;]+;/.test(s)) return false;            // css declarations
  const words = s.split(/\s+/);
  if (words.length === 1) {
    if (/[_/\\=]|^[A-Z0-9_-]+$|[a-z][A-Z]|-|\.\w/.test(s)) return false; // ids, CONSTANTS, camelCase, paths, file.ext
    return /^[A-Z][a-z]/.test(s) || /^\p{Lu}/u.test(s) || (lenient && /^[a-z]{3,}[.,:!?…]?$/.test(s));
  }
  // A lowercase phrase without punctuation is most likely a class list, unless it
  // sits next to an interpolation ("{0} active agents", JSX text around {count}).
  if (!prose && !/[A-Z]/.test(s) && !/[.?!…:,]/.test(s)) return false;
  if (!prose && words.every((w) => /^[a-z0-9-]+$/.test(w)) && !/[.?!…]/.test(s)) return false;
  if (prose && words.some((w) => /^[a-z]+-[a-z-]+$/.test(w)) && !/[.?!…]/.test(s)) return false;
  if (words.filter((w) => /[_{}]|^\.|[a-z][A-Z]/.test(w) && !/^\{\d+\}$/.test(w)).length > words.length / 2) return false;
  return true;
}

const renumber = (s: string) => { let i = 0; const map = new Map<string, string>(); return s.replace(/\{(\d+)\}/g, (_m, n) => { if (!map.has(n)) map.set(n, `{${i++}}`); return map.get(n)!; }); };
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&middot;/g, "·").replace(/&rarr;/g, "→").replace(/&hellip;/g, "…").replace(/&mdash;/g, "—").replace(/&ndash;/g, "–")
  .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)));

/** Split a markup-ish string into visible text segments and UI attribute values. */
function fromMarkup(text: string, out: Set<string>, htmlExprs: Set<string> = new Set()) {
  for (const m of text.matchAll(UI_ATTRS)) add(m[3], out);
  const noTags = text.replace(/<!--[\s\S]*?-->/g, "\u0000").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "\u0000").replace(/<[^>]*>/g, "\u0000");
  for (let seg of noTags.split("\u0000")) {
    // Placeholders whose expression produces markup break the text node in two.
    let split = false;
    for (const p of htmlExprs) if (seg.includes(p)) { seg = seg.split(p).join("\u0000"); split = true; }
    for (const piece of seg.split("\u0000")) add(piece, out, split);
  }
}

function add(raw: string, out: Set<string>, lenient = false) {
  const s = renumber(norm(decode(raw)));
  if (isUiText(s, lenient)) out.add(s);
}

interface Lit { text: string; htmlExprs: Set<string> }

/** Scan JS/TS source for string and template literals (expressions become {n}). */
export function scanLiterals(src: string): Lit[] {
  const lits: Lit[] = [];
  let i = 0;
  const n = src.length;
  function code(stopAtBrace: boolean): void {
    let depth = 0;
    let prev = ""; // last significant character, to tell a regex from division
    while (i < n) {
      const c = src[i];
      // A regex literal is skipped whole, so `//` or quotes inside it ("/^cid:\/\/x\//") are not read
      // as a comment or a string. Checked before comments for that reason.
      if (c === "/" && !"/*>".includes(src[i + 1] ?? "") && regexAllowed(prev) && regex()) { prev = "/"; continue; }
      if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === "'" || c === '"') { quoted(c); prev = c; continue; }
      if (c === "`") { template(); prev = c; continue; }
      if (c === "{") depth++;
      if (c === "}") { if (stopAtBrace && depth === 0) return; depth--; }
      if (/[A-Za-z0-9_$]/.test(c)) {
        const start = i;
        while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++;
        prev = src.slice(start, i);
        continue;
      }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  // After an operator, an opening bracket, a keyword or nothing, `/` starts a regex; after a value it divides.
  // After `<` it is a JSX closing tag (`</p>`), and before `>` a self-closing one (`<Copy text={a} />`), never a regex.
  function regexAllowed(prev: string): boolean {
    if (prev === "") return true;
    if (/^[A-Za-z_$]/.test(prev)) return /^(return|typeof|instanceof|in|of|case|delete|void|throw|new|yield|await|else|do)$/.test(prev);
    if (/^[0-9]/.test(prev)) return false;
    return "(,=:[!&|?{};+-*%~^>".includes(prev);
  }
  // Skip a regex literal at i (body, character classes, escapes, flags). A regex never spans lines,
  // so if the line ends first this was not a regex: leave i where it was and return false.
  function regex(): boolean {
    let j = i + 1;
    let inClass = false;
    while (j < n && src[j] !== "\n") {
      const ch = src[j];
      if (ch === "\\") { j += 2; continue; }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        i = j;
        return true;
      }
      j++;
    }
    return false;
  }
  function quoted(q: string) {
    let s = ""; i++;
    while (i < n && src[i] !== q && src[i] !== "\n") {
      if (src[i] === "\\") { s += unescape(src[i + 1]); i += 2; continue; }
      s += src[i++];
    }
    i++;
    lits.push({ text: s, htmlExprs: new Set() });
  }
  function template() {
    let s = ""; let k = 0; const htmlExprs = new Set<string>(); i++;
    while (i < n && src[i] !== "`") {
      if (src[i] === "\\") { s += unescape(src[i + 1]); i += 2; continue; }
      if (src[i] === "$" && src[i + 1] === "{") {
        i += 2; const start = i; code(true); const expr = src.slice(start, i); i++;
        const ph = `{${k++}}`;
        if (/[`<]|\.join\(|\.map\(/.test(expr)) htmlExprs.add(ph);
        s += ph; continue;
      }
      s += src[i++];
    }
    i++;
    lits.push({ text: s, htmlExprs });
  }
  const unescape = (c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c ?? "");
  code(false);
  return lits;
}

/** All UI strings in one source file. */
export function extractFromSource(src: string, ext: string): string[] {
  const out = new Set<string>();
  if (ext === ".html") {
    fromMarkup(src.replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_m, js) => { for (const l of scanLiterals(js)) fromMarkup(l.text, out, l.htmlExprs); return ""; }), out);
    return [...out];
  }
  for (const l of scanLiterals(src)) fromMarkup(l.text, out, l.htmlExprs);
  if (ext === ".jsx" || ext === ".tsx") {
    // JSX text between tags; {expressions} split it into separate text nodes.
    for (const m of src.matchAll(/>([^<>]+)</g)) {
      if (/[=;]\s*$|^\s*[)}\]]/.test(m[1]) && !/[A-Za-z]{3}/.test(m[1])) continue;
      const pieces = m[1].split(/\{[^{}]*\}/);
      for (const piece of pieces) add(piece, out, pieces.length > 1);
    }
  }
  return [...out];
}

/** Merge newly found strings into an existing en.json, keeping hand-added keys with dotted names. */
export function mergeCatalog(existing: Record<string, string>, found: string[], prune = true): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(existing)) if (!prune || found.includes(k) || k !== v) result[k] = v;
  for (const s of found.sort((a, b) => a.localeCompare(b))) if (!(s in result)) result[s] = s;
  return result;
}
