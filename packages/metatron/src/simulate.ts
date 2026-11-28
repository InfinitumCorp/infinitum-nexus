/**
 * METATRON¹⁰⁰ scenario engine: "what if?" simulation.
 *
 * A scenario model is a small world written as JSON:
 *
 * - `variables`: uncertain inputs, drawn once per run (a rate decision, a price).
 * - `shocks`: noise drawn fresh every step (weekly demand swings).
 * - `state`: the stocks that carry over between steps (cash, customers).
 * - `derived`: flows computed each step, in order (revenue = customers × price).
 * - `update`: how each stock changes; every update uses the values before the step.
 * - `agents`: optionally, a population (customers, voters, suppliers) that each
 *   follow their own rules; the world sees them through `mean_<x>` and
 *   `sum_<x>` (and `agents_count`).
 *
 * The model is run forward many times (Monte Carlo). Each run is one
 * possible future. An intervention changes an input or a rule ("rates go to
 * 5.5%", "supplier delay of 6 weeks from step 4") and `compare` runs it
 * against the baseline with the same random draws, so the difference you see
 * is the effect of the change and not luck.
 *
 * Forecasts are probabilities that support a decision, not certainties.
 */
import { compile, type Compiled } from "./expr.ts";
import { checkDist, isFixed, quantileSorted, sample, type Dist, type DistInput } from "./distributions.ts";
import { createRng, hash, type Rng } from "./rng.ts";

export interface AgentSpec {
  count: number;
  /** Per-agent traits, drawn once per agent per run. */
  attributes?: Record<string, DistInput>;
  /** Per-agent starting state: a number or a formula. */
  state: Record<string, number | string>;
  /** Per-agent rules, applied every step. */
  update: Record<string, string>;
}

export interface ScenarioModel {
  name?: string;
  steps: number;
  /** What one step is, for display (e.g. "week"). */
  stepUnit?: string;
  variables?: Record<string, DistInput>;
  shocks?: Record<string, DistInput>;
  /** Starting stocks: a number, or a formula over the variables. */
  state: Record<string, number | string>;
  derived?: Record<string, string>;
  update: Record<string, string>;
  agents?: AgentSpec;
  /** Names to report. Defaults to every state and derived value (and agent aggregates). */
  outputs?: string[];
}

export interface Intervention {
  name: string;
  description?: string;
  /** Replace an input's distribution, or pin it to a number. */
  variables?: Record<string, DistInput>;
  shocks?: Record<string, DistInput>;
  /** Replace starting values. */
  state?: Record<string, number | string>;
  /** Replace rules from step `from` on (default 1, the first step). */
  derived?: Record<string, string>;
  update?: Record<string, string>;
  from?: number;
}

export interface SimulateOptions {
  runs?: number;
  seed?: number;
  /** Named conditions to watch, e.g. `{ broke: "cash < 0" }`. */
  events?: Record<string, string>;
  /** Keep each run's final values (needed by `compare`). */
  keepFinal?: boolean;
}

export interface Summary {
  mean: number;
  sd: number;
  min: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  max: number;
}

export interface Band {
  mean: number[];
  p5: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p95: number[];
}

export interface EventResult {
  /** Share of runs where the condition was true at any step. */
  probability: number;
  /** Share of runs where it was true at the last step. */
  atEnd: number;
  /** Median first step it happened, over runs where it did (NaN if never). */
  medianFirstStep: number;
}

export interface ScenarioResult {
  name: string;
  runs: number;
  steps: number;
  seed: number;
  stepUnit?: string;
  /** Step-by-step bands; index 0 is step 1. */
  series: Record<string, Band>;
  final: Record<string, Summary>;
  events: Record<string, EventResult>;
  /** Present when `keepFinal` is set: final value of each output, per run. */
  finalRuns?: Record<string, Float64Array>;
}

export const LIMITS = {
  steps: 1000,
  runs: 20000,
  agents: 100000,
  /** runs × steps × (agents + 1): a guard against requests that would run for minutes. */
  work: 20_000_000,
  outputs: 64,
  names: 256,
};

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(["t", "steps", "agents_count", "true", "false"]);

interface Compiledmodel {
  steps: number;
  vars: [string, Dist][];
  shocks: [string, Dist][];
  stateKeys: string[];
  stateInit: Compiled[];
  derivedKeys: string[];
  derived: Compiled[];
  updateKeys: string[];
  update: Compiled[];
  agents?: {
    count: number;
    attrs: [string, Dist][];
    stateKeys: string[];
    init: Compiled[];
    updateKeys: string[];
    update: Compiled[];
  };
  outputs: string[];
}

function strHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
}

/** Throws a readable error for a malformed model; returns nothing when it is fine. */
export function validateModel(model: ScenarioModel): void {
  prepare(model);
}

function prepare(model: ScenarioModel, iv?: Intervention): { base: Compiledmodel; after?: Compiledmodel; from: number } {
  if (!model || typeof model !== "object") throw new Error("model must be an object");
  if (!Number.isInteger(model.steps) || model.steps < 1 || model.steps > LIMITS.steps) {
    throw new Error(`steps must be a whole number from 1 to ${LIMITS.steps}`);
  }
  if (!model.state || typeof model.state !== "object") throw new Error("model needs a state");
  if (!model.update || typeof model.update !== "object") throw new Error("model needs update rules");

  const variables = { ...(model.variables ?? {}), ...(iv?.variables ?? {}) };
  const shocks = { ...(model.shocks ?? {}), ...(iv?.shocks ?? {}) };
  const state = { ...model.state, ...(iv?.state ?? {}) };
  if (iv) {
    for (const k of Object.keys(iv.variables ?? {})) if (!(k in (model.variables ?? {}))) throw new Error(`intervention "${iv.name}": unknown variable "${k}"`);
    for (const k of Object.keys(iv.shocks ?? {})) if (!(k in (model.shocks ?? {}))) throw new Error(`intervention "${iv.name}": unknown shock "${k}"`);
    for (const k of Object.keys(iv.state ?? {})) if (!(k in model.state)) throw new Error(`intervention "${iv.name}": unknown state "${k}"`);
    for (const k of Object.keys(iv.update ?? {})) if (!(k in model.state)) throw new Error(`intervention "${iv.name}": update for unknown state "${k}"`);
    for (const k of Object.keys(iv.derived ?? {})) if (!(k in (model.derived ?? {}))) throw new Error(`intervention "${iv.name}": unknown derived value "${k}"`);
  }

  const seen = new Set<string>();
  const claim = (kind: string, k: string) => {
    if (!NAME.test(k)) throw new Error(`${kind} name "${k}" must be letters, digits and _ (not starting with a digit)`);
    if (RESERVED.has(k) || /^(mean|sum)_/.test(k)) throw new Error(`${kind} name "${k}" is reserved`);
    if (seen.has(k)) throw new Error(`name "${k}" is used twice`);
    seen.add(k);
  };
  const vars = Object.entries(variables).map(([k, d]): [string, Dist] => (claim("variable", k), [k, checkDist(k, d)]));
  const shk = Object.entries(shocks).map(([k, d]): [string, Dist] => (claim("shock", k), [k, checkDist(k, d)]));
  const stateKeys = Object.keys(state);
  if (stateKeys.length === 0) throw new Error("model needs at least one state value");
  stateKeys.forEach((k) => claim("state", k));
  const derivedKeys = Object.keys(model.derived ?? {});
  derivedKeys.forEach((k) => claim("derived", k));

  const aggregates: string[] = [];
  let agentAttrs: [string, Dist][] = [];
  let agentStateKeys: string[] = [];
  if (model.agents) {
    const a = model.agents;
    if (!Number.isInteger(a.count) || a.count < 1 || a.count > LIMITS.agents) throw new Error(`agents.count must be from 1 to ${LIMITS.agents}`);
    if (!a.state || !a.update) throw new Error("agents need state and update");
    agentAttrs = Object.entries(a.attributes ?? {}).map(([k, d]): [string, Dist] => (claim("agent attribute", k), [k, checkDist(k, d)]));
    agentStateKeys = Object.keys(a.state);
    if (agentStateKeys.length === 0) throw new Error("agents need at least one state value");
    agentStateKeys.forEach((k) => claim("agent state", k));
    for (const k of Object.keys(a.update)) if (!agentStateKeys.includes(k)) throw new Error(`agent update for unknown state "${k}"`);
    aggregates.push("agents_count", ...agentStateKeys.flatMap((k) => [`mean_${k}`, `sum_${k}`]));
  }
  if (seen.size > LIMITS.names) throw new Error(`too many names (limit ${LIMITS.names})`);
  for (const k of Object.keys(model.update)) if (!stateKeys.includes(k)) throw new Error(`update for unknown state "${k}"`);

  const varNames = vars.map(([k]) => k);
  const shockNames = shk.map(([k]) => k);
  const scope = (...groups: string[][]) => new Set<string>(["t", "steps", ...groups.flat()]);
  const where = (what: string, f: () => Compiled): Compiled => {
    try {
      return f();
    } catch (e) {
      throw new Error(`${what}: ${(e as Error).message}`);
    }
  };
  const formula = (what: string, v: number | string, names: Set<string>): Compiled => {
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error(`${what}: must be a finite number`);
      return () => v;
    }
    if (typeof v !== "string") throw new Error(`${what}: must be a number or a formula`);
    return where(what, () => compile(v, { names }).run);
  };

  const stateInit = stateKeys.map((k) => formula(`state.${k}`, state[k]!, scope(varNames)));
  const build = (derivedSrc: Record<string, string>, updateSrc: Record<string, string>, agentUpdateSrc?: Record<string, string>): Compiledmodel => {
    const derived = derivedKeys.map((k, i) => formula(`derived.${k}`, derivedSrc[k]!, scope(varNames, shockNames, stateKeys, aggregates, derivedKeys.slice(0, i))));
    // Stocks with no rule stay as they are.
    const updateKeys = stateKeys.filter((k) => updateSrc[k] !== undefined);
    const update = updateKeys.map((k) => formula(`update.${k}`, updateSrc[k]!, scope(varNames, shockNames, stateKeys, aggregates, derivedKeys)));
    let agents: Compiledmodel["agents"];
    if (model.agents) {
      const attrNames = agentAttrs.map(([k]) => k);
      const init = agentStateKeys.map((k) => formula(`agents.state.${k}`, model.agents!.state[k]!, scope(varNames, stateKeys, attrNames)));
      const src = agentUpdateSrc ?? model.agents.update;
      const aKeys = agentStateKeys.filter((k) => src[k] !== undefined);
      const aUpdate = aKeys.map((k) => formula(`agents.update.${k}`, src[k]!, scope(varNames, shockNames, stateKeys, aggregates, derivedKeys, attrNames, agentStateKeys)));
      agents = { count: model.agents.count, attrs: agentAttrs, stateKeys: agentStateKeys, init, updateKeys: aKeys, update: aUpdate };
    }
    const all = [...stateKeys, ...derivedKeys, ...aggregates];
    const outputs = model.outputs ?? all;
    if (outputs.length === 0 || outputs.length > LIMITS.outputs) throw new Error(`outputs must list 1 to ${LIMITS.outputs} names`);
    for (const o of outputs) if (!all.includes(o)) throw new Error(`output "${o}" is not a state, derived or agent value`);
    return { steps: model.steps, vars, shocks: shk, stateKeys, stateInit, derivedKeys, derived, updateKeys, update, agents, outputs };
  };

  const base = build(model.derived ?? {}, model.update);
  const hasRuleChange = iv && (iv.derived || iv.update);
  const from = iv?.from ?? 1;
  if (!Number.isInteger(from) || from < 1 || from > model.steps) throw new Error(`intervention "${iv?.name}": from must be a step from 1 to ${model.steps}`);
  const after = hasRuleChange ? build({ ...(model.derived ?? {}), ...(iv!.derived ?? {}) }, { ...model.update, ...(iv!.update ?? {}) }) : undefined;
  return { base, after, from };
}

function summarize(values: Float64Array): Summary {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += sorted[i]!;
  mean /= n;
  let v = 0;
  for (let i = 0; i < n; i++) v += (sorted[i]! - mean) ** 2;
  return {
    mean,
    sd: Math.sqrt(v / Math.max(1, n - 1)),
    min: sorted[0]!,
    p5: quantileSorted(sorted, 0.05),
    p25: quantileSorted(sorted, 0.25),
    p50: quantileSorted(sorted, 0.5),
    p75: quantileSorted(sorted, 0.75),
    p95: quantileSorted(sorted, 0.95),
    max: sorted[n - 1]!,
  };
}

/** Run one scenario (the model, optionally changed by an intervention) many times. */
export function simulate(model: ScenarioModel, opts: SimulateOptions & { intervention?: Intervention } = {}): ScenarioResult {
  const runs = opts.runs ?? 1000;
  const seed = (opts.seed ?? 100) >>> 0;
  if (!Number.isInteger(runs) || runs < 1 || runs > LIMITS.runs) throw new Error(`runs must be from 1 to ${LIMITS.runs}`);
  const iv = opts.intervention;
  const { base, after, from } = prepare(model, iv);
  const steps = base.steps;
  const agentCount = base.agents?.count ?? 0;
  if (runs * steps * (agentCount + 1) > LIMITS.work) {
    throw new Error(`too much work: runs × steps × (agents + 1) must stay under ${LIMITS.work.toLocaleString("en-US")}`);
  }
  const outputs = base.outputs;
  if (outputs.length * steps * runs > 10_000_000) throw new Error("too many outputs × steps × runs to keep in memory; ask for fewer outputs");

  const eventSrc = opts.events ?? {};
  const eventNames = Object.keys(eventSrc);
  const allNames = new Set(["t", "steps", ...base.vars.map(([k]) => k), ...base.shocks.map(([k]) => k), ...base.stateKeys, ...base.derivedKeys,
    ...(base.agents ? ["agents_count", ...base.agents.stateKeys.flatMap((k) => [`mean_${k}`, `sum_${k}`])] : [])]);
  const events = eventNames.map((k) => {
    try {
      return compile(eventSrc[k]!, { names: allNames }).run;
    } catch (e) {
      throw new Error(`event "${k}": ${(e as Error).message}`);
    }
  });

  // values[o][step * runs + run]
  const values = outputs.map(() => new Float64Array(steps * runs));
  const everHit = eventNames.map(() => new Uint8Array(runs));
  const endHit = eventNames.map(() => new Uint8Array(runs));
  const firstStep = eventNames.map(() => new Float64Array(runs).fill(NaN));

  const env: Record<string, number> = { steps };

  for (let run = 0; run < runs; run++) {
    const runSeed = hash(seed, run);
    // One stream per name, so pinning one variable leaves every other draw unchanged.
    const stream = (name: string) => createRng(hash(runSeed, strHash(name)));
    const rules: Rng = stream("§rules");
    env.t = 0;
    for (const [k, d] of base.vars) env[k] = sample(d, stream(`var:${k}`));
    const shockStreams = base.shocks.map(([k]) => stream(`shock:${k}`));
    for (const [k] of base.shocks) env[k] = 0;
    for (const k of base.derivedKeys) env[k] = 0;

    const state = base.stateKeys.map((_, i) => base.stateInit[i]!(env, rules));
    base.stateKeys.forEach((k, i) => (env[k] = state[i]!));

    // Agents: columnar storage.
    let attr: Float64Array[] = [];
    let ast: Float64Array[] = [];
    const A = base.agents;
    if (A) {
      attr = A.attrs.map(([k, d]) => {
        const r = stream(`attr:${k}`);
        const col = new Float64Array(A.count);
        for (let i = 0; i < A.count; i++) col[i] = sample(d, r);
        return col;
      });
      ast = A.stateKeys.map(() => new Float64Array(A.count));
      for (let i = 0; i < A.count; i++) {
        A.attrs.forEach(([k], j) => (env[k] = attr[j]![i]!));
        // Agent init formulas see the variables, the world's starting state and the agent's attributes.
        A.stateKeys.forEach((k, j) => {
          const v = A.init[j]!(env, rules);
          ast[j]![i] = v;
          env[k] = v;
        });
      }
      aggregate(A.stateKeys, ast, A.count, env);
    }

    for (let step = 1; step <= steps; step++) {
      const m = after && step >= from ? after : base;
      env.t = step;
      base.shocks.forEach(([k, d], i) => (env[k] = sample(d, shockStreams[i]!)));
      m.derivedKeys.forEach((k, i) => (env[k] = m.derived[i]!(env, rules)));

      if (A && m.agents) {
        const ma = m.agents;
        const next = ma.updateKeys.map(() => 0);
        const cols = ma.updateKeys.map((k) => A.stateKeys.indexOf(k));
        for (let i = 0; i < A.count; i++) {
          A.attrs.forEach(([k], j) => (env[k] = attr[j]![i]!));
          A.stateKeys.forEach((k, j) => (env[k] = ast[j]![i]!));
          for (let u = 0; u < ma.update.length; u++) next[u] = ma.update[u]!(env, rules);
          for (let u = 0; u < cols.length; u++) ast[cols[u]!]![i] = next[u]!;
        }
        aggregate(A.stateKeys, ast, A.count, env);
      }

      const next = m.update.map((f) => f(env, rules));
      m.updateKeys.forEach((k, i) => (env[k] = next[i]!));

      for (let o = 0; o < outputs.length; o++) {
        const v = env[outputs[o]!]!;
        values[o]![(step - 1) * runs + run] = v;
      }
      for (let e = 0; e < events.length; e++) {
        const hit = events[e]!(env, rules) !== 0;
        if (hit) {
          if (!everHit[e]![run]) firstStep[e]![run] = step;
          everHit[e]![run] = 1;
        }
        if (step === steps) endHit[e]![run] = hit ? 1 : 0;
      }
    }
  }

  const series: Record<string, Band> = {};
  const final: Record<string, Summary> = {};
  const finalRuns: Record<string, Float64Array> = {};
  outputs.forEach((name, o) => {
    const band: Band = { mean: [], p5: [], p25: [], p50: [], p75: [], p95: [] };
    for (let s = 0; s < steps; s++) {
      const col = values[o]!.subarray(s * runs, (s + 1) * runs);
      const sm = summarize(col);
      band.mean.push(sm.mean);
      band.p5.push(sm.p5);
      band.p25.push(sm.p25);
      band.p50.push(sm.p50);
      band.p75.push(sm.p75);
      band.p95.push(sm.p95);
      if (s === steps - 1) {
        final[name] = sm;
        if (opts.keepFinal) finalRuns[name] = Float64Array.from(col);
      }
    }
    series[name] = band;
  });

  const ev: Record<string, EventResult> = {};
  eventNames.forEach((k, e) => {
    const hits = [...firstStep[e]!].filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    ev[k] = {
      probability: everHit[e]!.reduce((s, x) => s + x, 0) / runs,
      atEnd: endHit[e]!.reduce((s, x) => s + x, 0) / runs,
      medianFirstStep: hits.length ? quantileSorted(hits, 0.5) : NaN,
    };
  });

  return {
    name: iv?.name ?? model.name ?? "baseline",
    runs,
    steps,
    seed,
    ...(model.stepUnit ? { stepUnit: model.stepUnit } : {}),
    series,
    final,
    events: ev,
    ...(opts.keepFinal ? { finalRuns } : {}),
  };
}

function aggregate(keys: readonly string[], cols: readonly Float64Array[], count: number, env: Record<string, number>): void {
  env.agents_count = count;
  keys.forEach((k, j) => {
    let s = 0;
    const c = cols[j]!;
    for (let i = 0; i < count; i++) s += c[i]!;
    env[`sum_${k}`] = s;
    env[`mean_${k}`] = s / count;
  });
}

export interface Delta {
  /** Mean of (scenario − baseline) at the final step, paired run by run. */
  mean: number;
  /** 90% range of the paired difference across runs. */
  p5: number;
  p95: number;
  /** Share of runs where the scenario ended higher than the baseline. */
  probHigher: number;
  /** Relative change of the mean, in percent (NaN when the baseline mean is 0). */
  pct: number;
}

export interface Comparison {
  baseline: ScenarioResult;
  scenarios: (ScenarioResult & { description?: string; delta: Record<string, Delta> })[];
}

/** Run the baseline and each intervention with the same random draws, and report the paired differences. */
export function compare(model: ScenarioModel, interventions: readonly Intervention[], opts: SimulateOptions = {}): Comparison {
  if (interventions.length > 12) throw new Error("compare at most 12 scenarios at once");
  const names = new Set<string>();
  for (const iv of interventions) {
    if (!iv?.name) throw new Error("every intervention needs a name");
    if (names.has(iv.name)) throw new Error(`two interventions are called "${iv.name}"`);
    names.add(iv.name);
  }
  // Validate everything before running anything.
  interventions.forEach((iv) => prepare(model, iv));
  const baseline = simulate(model, { ...opts, keepFinal: true });
  const scenarios = interventions.map((iv) => {
    const r = simulate(model, { ...opts, intervention: iv, keepFinal: true });
    const delta: Record<string, Delta> = {};
    for (const [name, vals] of Object.entries(r.finalRuns!)) {
      const b = baseline.finalRuns![name]!;
      const d = new Float64Array(vals.length);
      let higher = 0;
      for (let i = 0; i < vals.length; i++) {
        d[i] = vals[i]! - b[i]!;
        if (d[i]! > 0) higher++;
      }
      const s = summarize(d);
      const bm = baseline.final[name]!.mean;
      delta[name] = { mean: s.mean, p5: s.p5, p95: s.p95, probHigher: higher / vals.length, pct: bm === 0 ? NaN : (s.mean / Math.abs(bm)) * 100 };
    }
    if (!opts.keepFinal) delete r.finalRuns;
    return { ...r, ...(iv.description ? { description: iv.description } : {}), delta };
  });
  if (!opts.keepFinal) delete baseline.finalRuns;
  return { baseline, scenarios };
}

export interface SensitivityRow {
  variable: string;
  /** The input's 10th and 90th percentile. */
  low: number;
  high: number;
  /** Mean final output with the input pinned low / high. */
  outputAtLow: number;
  outputAtHigh: number;
  /** |outputAtHigh − outputAtLow|: how much this input moves the answer. */
  swing: number;
}

/**
 * Which uncertain inputs matter most for one output ("tornado" chart).
 * Each variable is pinned to its 10th and then its 90th percentile while
 * the others stay uncertain, using the same random draws.
 */
export function sensitivity(model: ScenarioModel, output: string, opts: { runs?: number; seed?: number } = {}): SensitivityRow[] {
  const runs = opts.runs ?? 300;
  const seed = opts.seed ?? 100;
  const vars = Object.entries(model.variables ?? {}).map(([k, d]): [string, Dist] => [k, checkDist(k, d)]).filter(([, d]) => !isFixed(d));
  if (vars.length > 24) throw new Error("sensitivity handles at most 24 uncertain variables");
  const rows: SensitivityRow[] = [];
  for (const [k, d] of vars) {
    const r = createRng(hash(seed, strHash(k)));
    const draws = Float64Array.from({ length: 4000 }, () => sample(d, r)).sort();
    const low = quantileSorted(draws, 0.1);
    const high = quantileSorted(draws, 0.9);
    const at = (v: number) => simulate({ ...model, outputs: [output] }, { runs, seed, intervention: { name: `${k}=${v}`, variables: { [k]: v } } }).final[output]!.mean;
    const outputAtLow = at(low);
    const outputAtHigh = at(high);
    rows.push({ variable: k, low, high, outputAtLow, outputAtHigh, swing: Math.abs(outputAtHigh - outputAtLow) });
  }
  return rows.sort((a, b) => b.swing - a.swing);
}
