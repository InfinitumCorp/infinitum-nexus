// Cumulus://Spreads formula engine. Cells hold raw text; text starting with "=" is a formula.
// Supports + - * / ^ & = <> < > <= >=, parentheses, A1 references, A1:B9 ranges, Sheet2!A1
// references, and the common functions below. Errors show as #DIV/0!, #REF!, #NAME?, #VALUE!, #CIRC!.

export const colName = (i) => { let s = ""; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
export const colIndex = (name) => [...name].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
export const parseRef = (ref) => { const m = /^([A-Z]{1,3})([1-9][0-9]{0,5})$/.exec(ref); return m ? { col: colIndex(m[1]), row: Number(m[2]) - 1 } : null; };
export const refName = (col, row) => `${colName(col)}${row + 1}`;

class FormulaError { constructor(code) { this.code = code; } toString() { return this.code; } }
const err = (code) => new FormulaError(code);
export const isError = (v) => v instanceof FormulaError;

/* ---------------- tokenizer ---------------- */

function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?%?/.exec(src.slice(i));
      if (!m) throw err("#VALUE!");
      const t = m[0];
      out.push({ t: "num", v: t.endsWith("%") ? Number(t.slice(0, -1)) / 100 : Number(t) });
      i += t.length; continue;
    }
    if (c === '"') {
      let j = i + 1, s = "";
      for (; j < src.length; j++) {
        if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j++; continue; } break; }
        s += src[j];
      }
      if (j >= src.length) throw err("#VALUE!");
      out.push({ t: "str", v: s }); i = j + 1; continue;
    }
    const word = /^(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))!\$?([A-Za-z]{1,3})\$?([0-9]{1,6})|^\$?([A-Za-z]{1,3})\$?([0-9]{1,6})(?![A-Za-z0-9_(])|^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i));
    if (word) {
      if (word[3]) out.push({ t: "ref", sheet: word[1] ?? word[2], v: `${word[3].toUpperCase()}${word[4]}` });
      else if (word[5]) out.push({ t: "ref", v: `${word[5].toUpperCase()}${word[6]}` });
      else {
        const w = word[0].toUpperCase();
        if (w === "TRUE" || w === "FALSE") out.push({ t: "bool", v: w === "TRUE" });
        else out.push({ t: "name", v: w });
      }
      i += word[0].length; continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "<>"].includes(two)) { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("+-*/^&=<>(),:;".includes(c)) { out.push({ t: c === "," || c === ";" ? "," : "op", v: c }); i++; continue; }
    throw err("#NAME?");
  }
  return out;
}

/* ---------------- parser (precedence climbing) ---------------- */

const BIN = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };

function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];
  const take = () => tokens[p++];
  const expect = (v) => { const t = take(); if (!t || t.v !== v) throw err("#VALUE!"); };
  function primary() {
    const t = take();
    if (!t) throw err("#VALUE!");
    if (t.t === "num" || t.t === "str" || t.t === "bool") return { k: "lit", v: t.v };
    if (t.t === "op" && (t.v === "-" || t.v === "+")) return { k: "neg", sign: t.v, e: expr(5) };
    if (t.t === "op" && t.v === "(") { const e = expr(0); expect(")"); return e; }
    if (t.t === "ref") {
      if (peek()?.v === ":") {
        take();
        const end = take();
        if (!end || end.t !== "ref") throw err("#REF!");
        return { k: "range", sheet: t.sheet, from: t.v, to: end.v };
      }
      return { k: "ref", sheet: t.sheet, v: t.v };
    }
    if (t.t === "name") {
      if (peek()?.v !== "(") throw err("#NAME?");
      take();
      const args = [];
      if (peek()?.v !== ")") {
        for (;;) { args.push(expr(0)); if (peek()?.t === ",") { take(); continue; } break; }
      }
      expect(")");
      return { k: "call", name: t.v, args };
    }
    throw err("#VALUE!");
  }
  function expr(min) {
    let left = primary();
    for (;;) {
      const t = peek();
      if (!t || t.t !== "op" || !(t.v in BIN)) break;
      const prec = BIN[t.v];
      if (prec < min) break;
      take();
      const right = expr(t.v === "^" ? prec : prec + 1);
      left = { k: "bin", op: t.v, a: left, b: right };
    }
    return left;
  }
  const tree = expr(0);
  if (p < tokens.length) throw err("#VALUE!");
  return tree;
}

/* ---------------- values ---------------- */

const num = (v) => {
  if (isError(v)) throw v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === "" || v == null) return 0;
  const n = Number(String(v).replace(/,/g, ""));
  if (Number.isNaN(n)) throw err("#VALUE!");
  return n;
};
export const formatNumber = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e10) / 1e10));
const text = (v) => { if (isError(v)) throw v; if (v == null) return ""; if (typeof v === "boolean") return v ? "TRUE" : "FALSE"; if (typeof v === "number") return formatNumber(v); return String(v); };
const truthy = (v) => { if (isError(v)) throw v; if (typeof v === "string") { if (/^true$/i.test(v)) return true; if (/^false$/i.test(v) || v === "") return false; throw err("#VALUE!"); } return !!num(v); };

const flat = (args) => args.flat(Infinity);
const numbers = (args) => flat(args).filter((v) => typeof v === "number").map(Number);
function criteria(test) {
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(String(test));
  const op = m[1] || "=";
  const rhs = m[2];
  const rn = Number(rhs);
  return (v) => {
    if (isError(v)) return false;
    const both = rhs !== "" && !Number.isNaN(rn) && v !== "" && !Number.isNaN(Number(v));
    const a = both ? Number(v) : String(v ?? "").toLowerCase();
    const b = both ? rn : rhs.toLowerCase();
    return op === "=" ? a === b : op === "<>" ? a !== b : op === "<" ? a < b : op === ">" ? a > b : op === "<=" ? a <= b : a >= b;
  };
}

// Functions that take whole ranges; every other function gets a range's first value.
const RANGE_FUNCS = new Set(["SUM", "PRODUCT", "AVERAGE", "MIN", "MAX", "MEDIAN", "COUNT", "COUNTA", "COUNTBLANK", "CONCAT", "CONCATENATE", "AND", "OR", "TEXTJOIN", "COUNTIF", "SUMIF", "AVERAGEIF", "MATCH", "INDEX", "VLOOKUP", "HLOOKUP"]);

const FUNCS = {
  SUM: (a) => numbers(a).reduce((x, y) => x + y, 0),
  PRODUCT: (a) => numbers(a).reduce((x, y) => x * y, 1),
  AVERAGE: (a) => { const n = numbers(a); if (!n.length) throw err("#DIV/0!"); return n.reduce((x, y) => x + y, 0) / n.length; },
  MIN: (a) => { const n = numbers(a); return n.length ? Math.min(...n) : 0; },
  MAX: (a) => { const n = numbers(a); return n.length ? Math.max(...n) : 0; },
  MEDIAN: (a) => { const n = numbers(a).sort((x, y) => x - y); if (!n.length) throw err("#NUM!"); const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; },
  COUNT: (a) => numbers(a).length,
  COUNTA: (a) => flat(a).filter((v) => v !== "" && v != null).length,
  COUNTBLANK: (a) => flat(a).filter((v) => v === "" || v == null).length,
  COUNTIF: (a) => { const f = criteria(text(flat([a[1]])[0])); return flat([a[0]]).filter(f).length; },
  SUMIF: (a) => { const range = flat([a[0]]); const sums = a[2] !== undefined ? flat([a[2]]) : range; const f = criteria(text(flat([a[1]])[0])); return range.reduce((t, v, i) => (f(v) ? t + (Number(sums[i]) || 0) : t), 0); },
  AVERAGEIF: (a) => { const range = flat([a[0]]); const vals = a[2] !== undefined ? flat([a[2]]) : range; const f = criteria(text(flat([a[1]])[0])); const hit = range.map((v, i) => (f(v) ? Number(vals[i]) : NaN)).filter((n) => !Number.isNaN(n)); if (!hit.length) throw err("#DIV/0!"); return hit.reduce((x, y) => x + y, 0) / hit.length; },
  AND: (a) => flat(a).every((v) => truthy(v)),
  OR: (a) => flat(a).some((v) => truthy(v)),
  NOT: (a) => !truthy(a[0]),
  ABS: (a) => Math.abs(num(a[0])),
  ROUND: (a) => { const d = a[1] === undefined ? 0 : num(a[1]); const f = 10 ** d; return Math.round(num(a[0]) * f) / f; },
  ROUNDUP: (a) => { const d = a[1] === undefined ? 0 : num(a[1]); const f = 10 ** d; const x = num(a[0]); return (x < 0 ? -Math.ceil(-x * f) : Math.ceil(x * f)) / f; },
  ROUNDDOWN: (a) => { const d = a[1] === undefined ? 0 : num(a[1]); const f = 10 ** d; return Math.trunc(num(a[0]) * f) / f; },
  INT: (a) => Math.floor(num(a[0])),
  MOD: (a) => { const d = num(a[1]); if (d === 0) throw err("#DIV/0!"); const x = num(a[0]); return x - d * Math.floor(x / d); },
  POWER: (a) => num(a[0]) ** num(a[1]),
  SQRT: (a) => { const x = num(a[0]); if (x < 0) throw err("#NUM!"); return Math.sqrt(x); },
  PI: () => Math.PI,
  RAND: () => Math.random(),
  CONCAT: (a) => flat(a).map(text).join(""),
  CONCATENATE: (a) => flat(a).map(text).join(""),
  TEXTJOIN: (a) => { const sep = text(a[0]); const skip = truthy(flat([a[1]])[0]); return flat(a.slice(2)).map(text).filter((s) => !skip || s !== "").join(sep); },
  LEN: (a) => text(a[0]).length,
  UPPER: (a) => text(a[0]).toUpperCase(),
  LOWER: (a) => text(a[0]).toLowerCase(),
  PROPER: (a) => text(a[0]).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
  TRIM: (a) => text(a[0]).trim().replace(/\s+/g, " "),
  LEFT: (a) => text(a[0]).slice(0, a[1] === undefined ? 1 : num(a[1])),
  RIGHT: (a) => { const s = text(a[0]); const n = a[1] === undefined ? 1 : num(a[1]); return n ? s.slice(-n) : ""; },
  MID: (a) => text(a[0]).substr(num(a[1]) - 1, num(a[2])),
  FIND: (a) => { const i = text(a[1]).indexOf(text(a[0]), (a[2] === undefined ? 1 : num(a[2])) - 1); if (i < 0) throw err("#VALUE!"); return i + 1; },
  SUBSTITUTE: (a) => text(a[0]).split(text(a[1])).join(text(a[2])),
  VALUE: (a) => num(a[0]),
  ISBLANK: (a) => a[0] === "" || a[0] == null,
  ISNUMBER: (a) => typeof a[0] === "number",
  ISTEXT: (a) => typeof a[0] === "string" && a[0] !== "",
  TODAY: () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; },
  NOW: () => new Date().toLocaleString(),
  VLOOKUP: (a) => {
    const rows = a[1];
    if (!Array.isArray(rows) || !Array.isArray(rows[0])) throw err("#REF!");
    const key = flat([a[0]])[0];
    const col = num(flat([a[2]])[0]) - 1;
    const exact = a[3] === undefined ? false : !truthy(flat([a[3]])[0]);
    const match = (v) => (typeof key === "number" ? Number(v) === key : String(v).toLowerCase() === text(key).toLowerCase());
    let hit = rows.find((r) => match(r[0]));
    if (!hit && !exact && typeof key === "number") hit = [...rows].reverse().find((r) => typeof r[0] === "number" && r[0] <= key);
    if (!hit) throw err("#N/A");
    if (col < 0 || col >= hit.length) throw err("#REF!");
    return hit[col];
  },
  HLOOKUP: (a) => {
    const rows = a[1];
    if (!Array.isArray(rows) || !Array.isArray(rows[0])) throw err("#REF!");
    const r = num(flat([a[2]])[0]) - 1;
    const key = text(flat([a[0]])[0]).toLowerCase();
    const i = rows[0].findIndex((v) => String(v).toLowerCase() === key);
    if (i < 0) throw err("#N/A");
    if (r < 0 || r >= rows.length) throw err("#REF!");
    return rows[r][i];
  },
  INDEX: (a) => {
    const rows = Array.isArray(a[0]) ? a[0] : [[a[0]]];
    const r = num(flat([a[1]])[0]) - 1;
    const c = a[2] === undefined ? 0 : num(flat([a[2]])[0]) - 1;
    const v = rows.length === 1 && a[2] === undefined ? rows[0][r] : rows[r]?.[c];
    if (v === undefined) throw err("#REF!");
    return v;
  },
  MATCH: (a) => { const list = flat([a[1]]); const key = text(flat([a[0]])[0]).toLowerCase(); const i = list.findIndex((v) => text(v).toLowerCase() === key); if (i < 0) throw err("#N/A"); return i + 1; },
};
export const FUNCTION_NAMES = [...Object.keys(FUNCS), "IF", "IFERROR"].sort();

/* ---------------- evaluating a workbook ---------------- */

/** Raw text of a cell, from either a plain string or a { v, s } formatted cell. */
export const rawOf = (cell) => (cell == null ? "" : typeof cell === "string" ? cell : String(cell.v ?? ""));

/** Turns literal cell text into a value: numbers become numbers, TRUE/FALSE become booleans. */
export function literal(raw) {
  const t = raw.trim();
  if (t === "") return "";
  if (/^-?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ""));
  if (/^-?\d*\.\d+$/.test(t) || /^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(t)) return Number(t);
  if (/^-?\d+(\.\d+)?%$/.test(t)) return Number(t.slice(0, -1)) / 100;
  if (/^(true|false)$/i.test(t)) return /^true$/i.test(t);
  return raw;
}

/**
 * Evaluates cells on demand, with caching and cycle detection.
 * sheets: [{ name, cells: { A1: raw | { v: raw } } }]
 */
export function workbook(sheets) {
  const cache = new Map();
  const busy = new Set();
  const sheetIndex = (name) => sheets.findIndex((s) => s.name.toLowerCase() === String(name).toLowerCase());

  function value(si, ref) {
    const key = `${si}!${ref}`;
    if (cache.has(key)) return cache.get(key);
    if (busy.has(key)) return err("#CIRC!");
    const raw = rawOf(sheets[si]?.cells?.[ref]);
    let out;
    if (!raw.startsWith("=") || raw.length === 1) out = literal(raw);
    else {
      busy.add(key);
      try {
        out = run(parse(tokenize(raw.slice(1))), si);
        if (Array.isArray(out)) out = out.flat(Infinity)[0] ?? "";
        if (typeof out === "number" && !Number.isFinite(out)) out = err("#NUM!");
      } catch (e) {
        out = isError(e) ? e : err("#VALUE!");
      } finally {
        busy.delete(key);
      }
    }
    cache.set(key, out);
    return out;
  }

  const target = (si, sheet) => {
    if (sheet === undefined) return si;
    const t = sheetIndex(sheet);
    if (t < 0) throw err("#REF!");
    return t;
  };

  function range(si, node) {
    const t = target(si, node.sheet);
    const a = parseRef(node.from), b = parseRef(node.to);
    if (!a || !b) throw err("#REF!");
    if ((Math.abs(a.row - b.row) + 1) * (Math.abs(a.col - b.col) + 1) > 200000) throw err("#REF!");
    const rows = [];
    for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++) {
      const row = [];
      for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) {
        const v = value(t, refName(c, r));
        if (isError(v)) throw v;
        row.push(v);
      }
      rows.push(row);
    }
    return rows;
  }

  function run(node, si) {
    switch (node.k) {
      case "lit": return node.v;
      case "neg": { const v = num(scalar(run(node.e, si))); return node.sign === "-" ? -v : v; }
      case "ref": {
        if (!parseRef(node.v)) throw err("#REF!");
        const v = value(target(si, node.sheet), node.v);
        if (isError(v)) throw v;
        return v;
      }
      case "range": return range(si, node);
      case "bin": {
        const a = scalar(run(node.a, si)), b = scalar(run(node.b, si));
        switch (node.op) {
          case "+": return num(a) + num(b);
          case "-": return num(a) - num(b);
          case "*": return num(a) * num(b);
          case "/": { const d = num(b); if (d === 0) throw err("#DIV/0!"); return num(a) / d; }
          case "^": return num(a) ** num(b);
          case "&": return text(a) + text(b);
          default: {
            const both = typeof a === "number" && typeof b === "number";
            const x = both ? a : text(a).toLowerCase(), y = both ? b : text(b).toLowerCase();
            return node.op === "=" ? x === y : node.op === "<>" ? x !== y : node.op === "<" ? x < y : node.op === ">" ? x > y : node.op === "<=" ? x <= y : x >= y;
          }
        }
      }
      case "call": {
        if (node.name === "IFERROR") {
          try { return scalar(run(node.args[0], si)); } catch (e) { if (isError(e)) return node.args[1] ? scalar(run(node.args[1], si)) : ""; throw e; }
        }
        if (node.name === "IF") {
          // Only the branch taken is evaluated.
          return truthy(scalar(run(node.args[0], si))) ? (node.args[1] ? scalar(run(node.args[1], si)) : true) : (node.args[2] ? scalar(run(node.args[2], si)) : false);
        }
        const f = FUNCS[node.name];
        if (!f) throw err("#NAME?");
        const args = node.args.map((a) => { const v = run(a, si); return RANGE_FUNCS.has(node.name) ? v : scalar(v); });
        return f(args);
      }
    }
    throw err("#VALUE!");
  }
  const scalar = (v) => (Array.isArray(v) ? (v.flat(Infinity)[0] ?? "") : v);

  return { value };
}

/** What a cell shows: formatted number, text, TRUE/FALSE or an error code. */
export function display(v, fmt) {
  if (isError(v)) return v.code;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (fmt === "pct") return `${formatNumber(Math.round(v * 10000) / 100)}%`;
    if (fmt === "money") return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
    if (fmt === "num2") return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return formatNumber(v);
  }
  return String(v ?? "");
}

/** Moves the references in a formula by (dc, dr), for copy and fill. $-anchored parts stay put. */
export function shiftFormula(raw, dc, dr) {
  if (!raw.startsWith("=")) return raw;
  return raw.replace(/("[^"]*")|(\$?)([A-Z]{1,3})(\$?)([0-9]{1,6})(?![A-Za-z0-9_(])/g, (m, str, c$, col, r$, row) => {
    if (str) return str;
    const ci = c$ ? colIndex(col) : colIndex(col) + dc;
    const ri = r$ ? Number(row) - 1 : Number(row) - 1 + dr;
    if (ci < 0 || ri < 0) return "#REF!";
    return `${c$}${colName(ci)}${r$}${ri + 1}`;
  });
}

/** CSV in and out (RFC 4180). */
export function toCSV(rows) {
  return rows.map((r) => r.map((v) => { const s = String(v ?? ""); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\r\n");
}
export function fromCSV(input) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (q) {
      if (c === '"') { if (input[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && input[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
