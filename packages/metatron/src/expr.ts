/**
 * METATRON scenario expressions.
 *
 * Scenario models arrive as JSON (from Spectre, the API or a saved file), so
 * their rules are small formulas such as `revenue * (1 + growth) - churn`.
 * This is a tiny, safe language: numbers, names, arithmetic, comparisons,
 * `a ? b : c`, and a fixed list of functions. There is no `eval`, no property
 * access and no loops, so a formula cannot reach anything but the values it
 * is given.
 *
 * Booleans are numbers: comparisons give 1 or 0, and anything non-zero is true.
 */
import type { Rng } from "./rng.ts";

export type Env = Readonly<Record<string, number>>;
export type Compiled = (env: Env, rng: Rng) => number;

export class ExprError extends Error {
  readonly source: string;
  readonly at?: number;
  constructor(message: string, source: string, at?: number) {
    super(at === undefined ? `${message} in "${source}"` : `${message} at ${at} in "${source}"`);
    this.name = "ExprError";
    this.source = source;
    if (at !== undefined) this.at = at;
  }
}

type Fn = (args: number[], rng: Rng) => number;

const n = (f: (...a: number[]) => number, arity: number | [number, number]): { f: Fn; arity: [number, number] } => ({
  f: (a) => f(...a),
  arity: typeof arity === "number" ? [arity, arity] : arity,
});

const FUNCTIONS: Record<string, { f: Fn; arity: [number, number] }> = {
  min: n(Math.min, [1, 16]),
  max: n(Math.max, [1, 16]),
  abs: n(Math.abs, 1),
  exp: n(Math.exp, 1),
  log: n(Math.log, 1),
  sqrt: n(Math.sqrt, 1),
  floor: n(Math.floor, 1),
  ceil: n(Math.ceil, 1),
  round: n(Math.round, 1),
  pow: n(Math.pow, 2),
  clamp: n((x, lo, hi) => Math.min(hi, Math.max(lo, x)), 3),
  logistic: n((x) => 1 / (1 + Math.exp(-x)), 1),
  // Random draws use the simulation's seeded stream, so runs stay reproducible.
  uniform: { f: (a, r) => r.uniform(a[0]!, a[1]!), arity: [2, 2] },
  normal: { f: (a, r) => r.normal(a[0]!, a[1]!), arity: [2, 2] },
  bernoulli: { f: (a, r) => (r.bernoulli(a[0]!) ? 1 : 0), arity: [1, 1] },
};

export const FUNCTION_NAMES: readonly string[] = Object.keys(FUNCTIONS);

type Tok =
  | { t: "num"; v: number; at: number }
  | { t: "id"; v: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "end"; at: number };

const OPS = ["<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "^", "<", ">", "!", "?", ":", "(", ")", ","];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!m) throw new ExprError("bad number", src, i);
      out.push({ t: "num", v: Number(m[0]), at: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0], at: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected "${c}"`, src, i);
    out.push({ t: "op", v: op, at: i });
    i += op.length;
  }
  out.push({ t: "end", at: src.length });
  return out;
}

export interface CompileOptions {
  /** If given, every name must be in this set (checked at compile time). */
  names?: ReadonlySet<string>;
}

/** Compile a formula once; call the result many times. Also returns the names it reads. */
export function compile(src: string, opts: CompileOptions = {}): { run: Compiled; names: Set<string> } {
  if (src.length > 2000) throw new ExprError("formula too long", src.slice(0, 40) + "…");
  const toks = lex(src);
  let p = 0;
  const names = new Set<string>();
  const peek = () => toks[p]!;
  const isOp = (v: string) => {
    const t = peek();
    return t.t === "op" && t.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError(`expected "${v}"`, src, peek().at);
    p++;
  };
  let depth = 0;

  function expr(): Compiled {
    if (++depth > 64) throw new ExprError("formula nested too deeply", src, peek().at);
    const r = ternary();
    depth--;
    return r;
  }
  function ternary(): Compiled {
    const c = or();
    if (!isOp("?")) return c;
    p++;
    const a = expr();
    expect(":");
    const b = expr();
    return (e, r) => (c(e, r) !== 0 ? a(e, r) : b(e, r));
  }
  function or(): Compiled {
    let l = and();
    while (isOp("||")) {
      p++;
      const a = l;
      const b = and();
      l = (e, r) => (a(e, r) !== 0 || b(e, r) !== 0 ? 1 : 0);
    }
    return l;
  }
  function and(): Compiled {
    let l = cmp();
    while (isOp("&&")) {
      p++;
      const a = l;
      const b = cmp();
      l = (e, r) => (a(e, r) !== 0 && b(e, r) !== 0 ? 1 : 0);
    }
    return l;
  }
  function cmp(): Compiled {
    const a = add();
    const t = peek();
    if (t.t !== "op" || !["<", "<=", ">", ">=", "==", "!="].includes(t.v)) return a;
    p++;
    const b = add();
    switch (t.v) {
      case "<": return (e, r) => (a(e, r) < b(e, r) ? 1 : 0);
      case "<=": return (e, r) => (a(e, r) <= b(e, r) ? 1 : 0);
      case ">": return (e, r) => (a(e, r) > b(e, r) ? 1 : 0);
      case ">=": return (e, r) => (a(e, r) >= b(e, r) ? 1 : 0);
      case "==": return (e, r) => (a(e, r) === b(e, r) ? 1 : 0);
      default: return (e, r) => (a(e, r) !== b(e, r) ? 1 : 0);
    }
  }
  function add(): Compiled {
    let l = mul();
    for (;;) {
      if (isOp("+")) {
        p++;
        const a = l, b = mul();
        l = (e, r) => a(e, r) + b(e, r);
      } else if (isOp("-")) {
        p++;
        const a = l, b = mul();
        l = (e, r) => a(e, r) - b(e, r);
      } else return l;
    }
  }
  function mul(): Compiled {
    let l = unary();
    for (;;) {
      if (isOp("*")) {
        p++;
        const a = l, b = unary();
        l = (e, r) => a(e, r) * b(e, r);
      } else if (isOp("/")) {
        p++;
        const a = l, b = unary();
        l = (e, r) => a(e, r) / b(e, r);
      } else if (isOp("%")) {
        p++;
        const a = l, b = unary();
        l = (e, r) => a(e, r) % b(e, r);
      } else return l;
    }
  }
  function unary(): Compiled {
    if (isOp("-")) {
      p++;
      const a = unary();
      return (e, r) => -a(e, r);
    }
    if (isOp("+")) {
      p++;
      return unary();
    }
    if (isOp("!")) {
      p++;
      const a = unary();
      return (e, r) => (a(e, r) === 0 ? 1 : 0);
    }
    return pow();
  }
  function pow(): Compiled {
    const base = primary();
    if (!isOp("^")) return base;
    p++;
    const ex = unary(); // right-associative: 2^3^2 = 2^9
    return (e, r) => Math.pow(base(e, r), ex(e, r));
  }
  function primary(): Compiled {
    const t = peek();
    if (t.t === "num") {
      p++;
      const v = t.v;
      return () => v;
    }
    if (t.t === "id") {
      p++;
      if (isOp("(")) {
        p++;
        const fn = FUNCTIONS[t.v];
        if (!fn) throw new ExprError(`unknown function "${t.v}"`, src, t.at);
        const args: Compiled[] = [];
        if (!isOp(")")) {
          args.push(expr());
          while (isOp(",")) {
            p++;
            args.push(expr());
          }
        }
        expect(")");
        if (args.length < fn.arity[0] || args.length > fn.arity[1]) {
          throw new ExprError(`${t.v}() takes ${fn.arity[0] === fn.arity[1] ? fn.arity[0] : `${fn.arity[0]}–${fn.arity[1]}`} argument(s)`, src, t.at);
        }
        return (e, r) => fn.f(args.map((a) => a(e, r)), r);
      }
      const name = t.v;
      if (name === "true") return () => 1;
      if (name === "false") return () => 0;
      if (opts.names && !opts.names.has(name)) throw new ExprError(`unknown name "${name}"`, src, t.at);
      names.add(name);
      return (e) => {
        const v = e[name];
        if (v === undefined) throw new ExprError(`"${name}" has no value`, src, t.at);
        return v;
      };
    }
    if (isOp("(")) {
      p++;
      const a = expr();
      expect(")");
      return a;
    }
    throw new ExprError(t.t === "end" ? "unexpected end" : `unexpected "${t.v}"`, src, t.at);
  }

  const run = expr();
  if (peek().t !== "end") throw new ExprError(`unexpected "${(peek() as { v: string }).v}"`, src, peek().at);
  return { run, names };
}

/** One-off evaluation (compiles every call; use `compile` in loops). */
export function evaluateExpr(src: string, env: Env, rng: Rng): number {
  return compile(src).run(env, rng);
}
