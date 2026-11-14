/**
 * METATRON¹⁰⁰ routes: "what if?" scenarios, forecasts and signals.
 *
 *   GET  /api/metatron/templates        ready-made scenarios
 *   POST /api/metatron/simulate         run one scenario
 *   POST /api/metatron/compare          baseline vs. interventions (+ optional sensitivity)
 *   POST /api/metatron/forecast         forecast any series with ranges
 *   GET  /api/metatron/outlook          what the open pipeline will book
 *   GET  /api/metatron/signals          the workspace's weekly series, what changed, and a bookings forecast
 *   GET  /api/metatron/scenarios        the workspace's saved scenarios (newest change first)
 *   POST /api/metatron/scenarios        save one (a model, or a templateId to start from)
 *   GET|PATCH|DELETE /api/metatron/scenarios/:id
 *
 * simulate and compare also take a scenarioId to run a saved scenario.
 *
 * Simulations run inside the request, so each one gets a work budget: the
 * number of runs is lowered to fit and the response says how many were used.
 */
import {
  compare,
  digest,
  forecast,
  LIMITS,
  sensitivity,
  simulate,
  TEMPLATES,
  templateById,
  validateModel,
  type Intervention,
  type ScenarioModel,
} from "@infinitum/metatron";
import type { ScenarioInput, SpectreCRM } from "../core/crm.ts";
import type { SavedScenario } from "../core/model.ts";
import type { Score } from "../core/intelligence.ts";
import { OPEN_STAGES, type Stage } from "../core/model.ts";
import { pipelineOutlook, weeklySeries } from "../core/metatron-outlook.ts";

export interface MetatronApi {
  route: (method: string, path: string, handler: (ctx: any) => unknown, auth?: boolean, opts?: { csrf?: boolean; optionalAuth?: boolean }) => void;
  crm: SpectreCRM;
  httpError: (status: number, message: string) => Error;
  scoresFor: (ws: string) => Map<string, Score>;
}

/** Agent-steps per request: 3M is about 1.5 s of CPU. Override with METATRON_HTTP_WORK. */
export const HTTP_WORK = 3_000_000;
const workBudget = () => Number(process.env.METATRON_HTTP_WORK) || HTTP_WORK;
const MIN_RUNS = 20;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

export function registerMetatronRoutes(api: MetatronApi): void {
  const { route, crm, httpError } = api;

  /** Engine errors are the caller's input problems: report them as 400s with the engine's message. */
  const guard = <T>(f: () => T): T => {
    try {
      return f();
    } catch (e) {
      if (e && typeof e === "object" && "status" in e) throw e;
      throw httpError(400, (e as Error).message);
    }
  };

  const num = (v: unknown, name: string, fallback?: number): number | undefined => {
    if (v === undefined || v === null || v === "") return fallback;
    const n = Number(v);
    if (!Number.isFinite(n)) throw httpError(400, `${name} must be a number`);
    return n;
  };

  /** Pick runs to fit the budget; `scenarios` counts every simulation the request will make. */
  const budget = (model: ScenarioModel, requested: number | undefined, scenarios: number) => {
    const steps = Number(model.steps) || 1;
    const agents = model.agents ? Number(model.agents.count) || 0 : 0;
    const perRun = steps * (agents + 1) * scenarios;
    const fit = Math.floor(workBudget() / perRun);
    const want = requested ?? 1000;
    if (!Number.isInteger(want) || want < 1 || want > LIMITS.runs) throw httpError(400, `runs must be from 1 to ${LIMITS.runs}`);
    if (fit < MIN_RUNS) throw httpError(400, "this model is too large to run online: use fewer steps, agents or scenarios");
    return { runs: Math.min(want, fit), capped: want > fit };
  };

  const readModel = (body: Record<string, unknown>, ws: string): { model: ScenarioModel; interventions?: Intervention[]; events?: Record<string, string>; focus?: string } => {
    if (typeof body.scenarioId === "string") {
      const s = crm.scenario(ws, body.scenarioId);
      return { model: s.model as unknown as ScenarioModel, interventions: s.interventions as unknown as Intervention[], events: s.events, focus: s.focus };
    }
    if (typeof body.templateId === "string") {
      const t = templateById(body.templateId);
      if (!t) throw httpError(404, `No template "${body.templateId}"`);
      return { model: t.model, interventions: t.interventions, events: t.events, focus: t.focus };
    }
    if (!isObj(body.model)) throw httpError(400, "Send a model (or a templateId or scenarioId)");
    return { model: body.model as unknown as ScenarioModel };
  };

  const readEvents = (v: unknown): Record<string, string> | undefined => {
    if (v === undefined) return undefined;
    if (!isObj(v) || Object.values(v).some((x) => typeof x !== "string") || Object.keys(v).length > 16) throw httpError(400, "events must map up to 16 names to formulas");
    return v as Record<string, string>;
  };

  route("GET", "/api/metatron/templates", () => ({
    templates: TEMPLATES.map((t) => ({ id: t.id, title: t.title, question: t.question, focus: t.focus, model: t.model, interventions: t.interventions, events: t.events ?? {} })),
  }));

  route("POST", "/api/metatron/simulate", (ctx) => {
    const body = isObj(ctx.body) ? ctx.body : {};
    const { model, events: tplEvents } = readModel(body, ctx.user!.workspace);
    const intervention = body.intervention === undefined ? undefined : (body.intervention as Intervention);
    if (intervention !== undefined && !isObj(intervention)) throw httpError(400, "intervention must be an object");
    const { runs, capped } = budget(model, num(body.runs, "runs"), 1);
    const result = guard(() => simulate(model, { runs, seed: num(body.seed, "seed"), events: readEvents(body.events) ?? tplEvents, intervention }));
    return { ...result, capped };
  });

  route("POST", "/api/metatron/compare", (ctx) => {
    const body = isObj(ctx.body) ? ctx.body : {};
    const r = readModel(body, ctx.user!.workspace);
    const interventions = (body.interventions ?? r.interventions ?? []) as Intervention[];
    if (!Array.isArray(interventions) || interventions.length === 0) throw httpError(400, "Send at least one intervention to compare");
    if (interventions.length > 8) throw httpError(400, "Compare at most 8 interventions at once");
    const output = typeof body.sensitivity === "string" ? body.sensitivity : body.sensitivity === true ? r.focus : undefined;
    const uncertain = Object.keys(r.model.variables ?? {}).length;
    // Sensitivity runs two pinned scenarios per variable at a quarter of the runs.
    const sims = 1 + interventions.length + (output ? Math.ceil((2 * uncertain) / 4) : 0);
    const { runs, capped } = budget(r.model, num(body.runs, "runs"), sims);
    const seed = num(body.seed, "seed");
    const comparison = guard(() => compare(r.model, interventions, { runs, seed, events: readEvents(body.events) ?? r.events }));
    const sens = output ? guard(() => sensitivity(r.model, output, { runs: Math.max(MIN_RUNS, Math.floor(runs / 4)), seed })) : undefined;
    return { ...comparison, runs, capped, ...(sens ? { sensitivity: { output, rows: sens } } : {}) };
  });

  route("POST", "/api/metatron/forecast", (ctx) => {
    const body = isObj(ctx.body) ? ctx.body : {};
    const values = body.values;
    if (!Array.isArray(values) || values.length > 5000 || values.some((v) => typeof v !== "number")) throw httpError(400, "values must be a list of up to 5000 numbers");
    const horizon = num(body.horizon, "horizon", 12)!;
    if (horizon > 365) throw httpError(400, "horizon must be at most 365");
    return guard(() => forecast(values as number[], horizon, { period: num(body.period, "period"), level: num(body.level, "level") }));
  });

  route("GET", "/api/metatron/outlook", (ctx) => {
    const ws = ctx.user!.workspace;
    const stage = ctx.query.get("whatIfStage");
    const change = num(ctx.query.get("whatIfChange"), "whatIfChange");
    if (stage && !OPEN_STAGES.includes(stage as Stage)) throw httpError(400, `whatIfStage must be one of ${OPEN_STAGES.join(", ")}`);
    return guard(() =>
      pipelineOutlook(crm.list("deals", ws), api.scoresFor(ws), crm.now(), {
        horizonDays: num(ctx.query.get("horizonDays"), "horizonDays"),
        target: num(ctx.query.get("target"), "target"),
        ...(stage && change !== undefined ? { whatIf: { stage: stage as Stage, winRateChange: change } } : {}),
      }),
    );
  });

  route("GET", "/api/metatron/signals", (ctx) => {
    const ws = ctx.user!.workspace;
    const weeks = num(ctx.query.get("weeks"), "weeks", 26)!;
    const w = guard(() => weeklySeries(crm.list("deals", ws), crm.list("activities", ws), crm.now(), weeks));
    const labels = { wonValue: "Won value", wonDeals: "Deals won", newDeals: "New deals", activities: "Activity", inbound: "Inbound replies" };
    // The current week is still in progress (a Monday would always look like a drop),
    // so the digest and the forecast use complete weeks only.
    const complete = Object.fromEntries(Object.entries(w.series).map(([k, v]) => [k, v.slice(0, -1)]));
    const notable = digest(complete, { labels }).map((d) => ({ ...d, week: w.weeks[d.index] }));
    const won = complete.wonValue!;
    const bookings = won.some((v) => v !== 0) ? guard(() => forecast(won, 8)) : null;
    return { ...w, notable, bookings };
  });

  /* ---------------- saved scenarios ---------------- */

  const readInterventions = (v: unknown): Record<string, unknown>[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > 8 || v.some((x) => !isObj(x) || typeof x.name !== "string" || !x.name.trim())) {
      throw httpError(400, "interventions must be a list of up to 8 objects, each with a name");
    }
    return v as Record<string, unknown>[];
  };

  /** What a save or change sends, checked by the METATRON engine before it is kept. */
  const readScenario = (body: Record<string, unknown>, partial: boolean): Partial<ScenarioInput> => {
    const out: Partial<ScenarioInput> = {};
    if (body.name !== undefined) out.name = String(body.name);
    if (typeof body.templateId === "string" && !partial) {
      const t = templateById(body.templateId);
      if (!t) throw httpError(404, `No template "${body.templateId}"`);
      Object.assign(out, { templateId: t.id, model: t.model, interventions: t.interventions, events: t.events ?? {}, focus: t.focus });
      out.name ??= t.title;
    }
    if (body.model !== undefined) {
      if (!isObj(body.model)) throw httpError(400, "model must be an object");
      out.model = body.model;
    }
    if (out.model) guard(() => validateModel(out.model as unknown as ScenarioModel));
    const interventions = readInterventions(body.interventions);
    if (interventions) out.interventions = interventions;
    const events = readEvents(body.events);
    if (events) out.events = events;
    if (body.focus !== undefined) {
      if (typeof body.focus !== "string") throw httpError(400, "focus must be a name");
      out.focus = body.focus;
    }
    if (!partial && !out.model) throw httpError(400, "Send a model (or a templateId) to save");
    if (!partial && out.name === undefined) throw httpError(400, "Give the scenario a name");
    return out;
  };

  const summary = (s: SavedScenario) => ({
    id: s.id,
    name: s.name,
    templateId: s.templateId ?? null,
    steps: (s.model as { steps?: number }).steps ?? null,
    interventions: s.interventions.length,
    createdBy: s.createdBy,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  });

  route("GET", "/api/metatron/scenarios", (ctx) => ({
    scenarios: crm.list("scenarios", ctx.user!.workspace).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary),
  }));

  route("POST", "/api/metatron/scenarios", (ctx) => {
    const body = isObj(ctx.body) ? ctx.body : {};
    return crm.saveScenario(ctx.user!.workspace, ctx.user!.account.cid, readScenario(body, false) as ScenarioInput);
  });

  route("GET", "/api/metatron/scenarios/:id", (ctx) => crm.scenario(ctx.user!.workspace, ctx.params.id));

  route("PATCH", "/api/metatron/scenarios/:id", (ctx) => {
    const body = isObj(ctx.body) ? ctx.body : {};
    const patch = readScenario(body, true);
    // A new model must still fit the saved interventions, and the other way round.
    const current = crm.scenario(ctx.user!.workspace, ctx.params.id);
    const model = (patch.model ?? current.model) as unknown as ScenarioModel;
    const ivs = (patch.interventions ?? current.interventions) as unknown as Intervention[];
    if (patch.model || patch.interventions) guard(() => { if (ivs.length) compare(model, ivs, { runs: 1, seed: 1 }); });
    return crm.updateScenario(ctx.user!.workspace, ctx.user!.account.cid, ctx.params.id, patch);
  });

  route("DELETE", "/api/metatron/scenarios/:id", async (ctx) => {
    await crm.deleteScenario(ctx.user!.workspace, ctx.user!.account.cid, ctx.params.id);
    return { ok: true };
  });
}
