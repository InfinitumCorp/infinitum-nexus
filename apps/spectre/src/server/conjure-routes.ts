import { randomUUID } from "node:crypto";
import {
  createSimulation, conjureStep, conjureInject, conjureFork, conjureReport, conjureInterview, conjureEstimate, routerComplete, ConjureError, webSeed,
  type Complete, type Simulation, type WebSeed,
} from "@infinitum/conjure";
import type { Search } from "@infinitum/ai/search";
import type { SpectreCRM } from "../core/crm.ts";
import { aiConnected, AI_SETUP_HINT, type AiConfig } from "./ai.ts";

type StoredSim = Simulation & { workspace: string; dealId?: string; createdBy: string; webSources?: WebSeed["sources"] };

const MAX_PER_WORKSPACE = 20;

/** Seed material for "Simulate this deal": everything +SPCTR knows about it. */
export function dealSeed(crm: SpectreCRM, ws: string, dealId: string) {
  const d = crm.deal(ws, dealId);
  const company = crm.company(ws, d.companyId);
  const people = d.contactIds.map((id) => crm.store.contacts.get(id)).filter((c) => c && !c.optedOut);
  const acts = crm.activitiesFor(ws, { dealId }).slice(0, 25);
  const seed = [
    `Deal: ${d.name} with ${company.name}${company.industry ? ` (${company.industry})` : ""}. Stage: ${d.stage}. Value: ${d.amount} ${d.currency}. Expected close: ${d.closeDate}.`,
    company.facts.length ? `What we know about ${company.name}:\n${company.facts.slice(-15).map((f) => `- ${f.field}: ${f.value}`).join("\n")}` : "",
    people.length ? `People involved:\n${people.map((p) => `- ${p!.name}${p!.title ? `, ${p!.title}` : ""}${p!.influence ? ` (${p!.influence})` : ""}`).join("\n")}` : "",
    acts.length ? `History, newest first:\n${acts.map((a) => `- ${a.at.slice(0, 10)} ${a.kind}${a.inbound ? " (from them)" : ""}: ${a.summary}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return { question: `Will ${company.name} sign "${d.name}" by ${d.closeDate}?`, seed };
}

export function registerConjureRoutes(api: {
  route: (method: string, path: string, handler: (ctx: any) => unknown) => void;
  crm: SpectreCRM;
  ai: AiConfig;
  httpError: (status: number, message: string) => Error;
  /** Tests inject a scripted model. */
  complete?: Complete;
  /** Infinitum Search: seeds a forecast from the web when no material is given. */
  search?: Search | null;
}) {
  const { route, crm, ai, httpError } = api;

  const model = (): Complete => {
    if (api.complete) return api.complete;
    if (!aiConnected(ai)) throw httpError(503, `AI isn't connected. ${AI_SETUP_HINT}`);
    return routerComplete(ai.router);
  };
  const llm = () => {
    if (!aiConnected(ai) && !api.complete) throw httpError(503, `AI isn't connected. ${AI_SETUP_HINT}`);
    return { router: ai.router };
  };
  const get = (ctx: any): StoredSim => {
    const s = crm.store.simulations.get(ctx.params.id);
    if (!s || s.workspace !== ctx.user.workspace) throw httpError(404, "Simulation not found");
    return s;
  };
  const wrap = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ConjureError) throw httpError(400, err.message);
      throw err;
    }
  };
  const save = async (ctx: any, s: StoredSim, event: string, extra: Record<string, unknown> = {}) => {
    crm.store.simulations.set(s.id, s);
    await crm.record(ctx.user.account.cid, `conjure:${s.id}`, { event, round: s.round, calls: s.calls, ...extra });
  };
  /** Summary for lists: everything but the bulky feed and memories. */
  const summary = (s: StoredSim) => ({
    id: s.id, question: s.question, poles: s.poles, round: s.round, rounds: s.rounds, status: s.status, agents: s.personas.length,
    calls: s.calls, maxCalls: s.maxCalls, dealId: s.dealId, createdAt: s.createdAt, forkedFrom: s.forkedFrom,
    latest: s.stats.at(-1), outcome: s.report?.outcome, probability: s.report?.probability, webSources: s.webSources,
  });

  route("GET", "/api/conjure", (ctx) => ({
    aiConnected: aiConnected(ai) || Boolean(api.complete),
    simulations: crm.list("simulations", ctx.user.workspace).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(summary),
  }));

  route("GET", "/api/conjure/estimate", (ctx) => conjureEstimate(Number(ctx.query.get("agents") ?? 24), Number(ctx.query.get("rounds") ?? 5)));

  route("GET", "/api/conjure/:id", (ctx) => {
    const s = get(ctx);
    const names = Object.fromEntries(s.personas.map((p) => [p.id, p.name]));
    return { ...s, feed: s.feed.slice(-300).map((x) => ({ ...x, author: x.authorId === "world" ? "NEWS" : names[x.authorId] })) };
  });

  /** New simulation from seed text, or from a deal's records (dealId). */
  route("POST", "/api/conjure", (ctx) => wrap(async () => {
    const ws = ctx.user.workspace;
    let { question, seed } = ctx.body as { question?: string; seed?: string };
    const dealId = typeof ctx.body.dealId === "string" ? ctx.body.dealId : undefined;
    if (dealId) {
      const d = dealSeed(crm, ws, dealId);
      question = question?.trim() || d.question;
      seed = [d.seed, seed?.trim()].filter(Boolean).join("\n\nAdditional context:\n");
    }
    // No material (or "web": true): research the question on the web and seed from the cited brief.
    let web: WebSeed | undefined;
    if (!dealId && (ctx.body.web === true || String(seed ?? "").trim().length < 40) && String(question ?? "").trim()) {
      if (!api.search) {
        if (ctx.body.web === true) throw httpError(503, "Infinitum Search isn't connected. Set SEARXNG_URL, YANDEX_SEARCH_API_KEY + YANDEX_FOLDER_ID, or BRAVE_SEARCH_API_KEY.");
      } else {
        web = await webSeed(api.search, String(question));
        seed = [seed?.trim(), web.seed].filter(Boolean).join("\n\n");
      }
    }
    const sim = await createSimulation(model(), {
      id: `sim_${randomUUID()}`, question: String(question ?? ""), seed: String(seed ?? ""),
      agents: Number(ctx.body.agents) || undefined, rounds: Number(ctx.body.rounds) || undefined, now: crm.now(),
    });
    const stored: StoredSim = { ...sim, workspace: ws, dealId, createdBy: ctx.user.account.cid, ...(web ? { webSources: web.sources } : {}) };
    // Keep the most recent simulations per workspace.
    const mine = crm.list("simulations", ws).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const old of mine.slice(MAX_PER_WORKSPACE - 1)) crm.store.simulations.delete(old.id);
    await save(ctx, stored, "conjure.created", { agents: sim.personas.length, rounds: sim.rounds, deal: dealId ?? null, web: web ? web.sources.length : 0 });
    return summary(stored);
  }));

  /** Advance one round (call repeatedly; each call is short enough for serverless hosts). */
  route("POST", "/api/conjure/:id/step", (ctx) => wrap(async () => {
    const s = get(ctx);
    await conjureStep(model(), s);
    await save(ctx, s, "conjure.round");
    return summary(s);
  }));

  route("POST", "/api/conjure/:id/inject", (ctx) => wrap(async () => {
    const s = get(ctx);
    conjureInject(s, String(ctx.body.text ?? ""), ctx.body.round === undefined ? undefined : Number(ctx.body.round));
    await save(ctx, s, "conjure.injected");
    return { injections: s.injections };
  }));

  route("POST", "/api/conjure/:id/fork", (ctx) => wrap(async () => {
    const s = get(ctx);
    const f = conjureFork(s, `sim_${randomUUID()}`, ctx.body.round === undefined ? s.round : Number(ctx.body.round));
    const stored: StoredSim = { ...f, workspace: s.workspace, dealId: s.dealId, createdBy: ctx.user.account.cid, createdAt: crm.now().toISOString(), maxCalls: s.maxCalls };
    await save(ctx, stored, "conjure.forked", { from: s.id });
    return summary(stored);
  }));

  route("POST", "/api/conjure/:id/report", (ctx) => wrap(async () => {
    const s = get(ctx);
    const report = await conjureReport(llm(), s);
    await save(ctx, s, "conjure.report", { probability: report.probability });
    return report;
  }));

  route("POST", "/api/conjure/:id/interview", (ctx) => wrap(async () => {
    const s = get(ctx);
    const history = Array.isArray(ctx.body.history) ? ctx.body.history.slice(-6).map((h: any) => ({ q: String(h.q ?? ""), a: String(h.a ?? "") })) : [];
    const answer = await conjureInterview(model(), s, String(ctx.body.agentId ?? ""), String(ctx.body.question ?? ""), history);
    crm.store.simulations.set(s.id, s); // call count changed
    return { answer };
  }));

  route("DELETE", "/api/conjure/:id", async (ctx) => {
    const s = get(ctx);
    crm.store.simulations.delete(s.id);
    await crm.record(ctx.user.account.cid, `conjure:${s.id}`, { event: "conjure.deleted" });
    return { ok: true };
  });
}
