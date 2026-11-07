/**
 * METATRON learned model for a Spectre workspace.
 *
 * Once a workspace has enough closed deals (won and lost), METATRON trains a
 * logistic model on what was true about each deal when it closed: contact
 * recency, touches, inbound replies, amount, market and industry. Spectre
 * keeps no stage history, so stage stays with the default model as the
 * prior, and the learned model adds the workspace's own evidence on top:
 *
 *   logit(p) = logit(stage prior) + Σ learned contributions
 *
 * The model is cached per workspace and retrained when the set of closed
 * deals changes. Below the threshold the default scorer is used unchanged.
 */
import {
  backtestProbability,
  predict,
  train,
  type LearnedModel,
  type ProbabilityBacktest,
  type TimedRow,
} from "@infinitum/metatron";
import type { Activity, Company, Deal } from "./model.ts";

export const MIN_CLOSED_DEALS = 30;
export const DEFAULT_MODEL = "metatron-default-v1";
export const LEARNED_MODEL = "metatron-logistic-v1";

const DAY = 86_400_000;

export type DealFeatures = Record<string, number | string | boolean>;

/** What METATRON knows about a deal as of a moment (close time for history, now for open deals). */
export function dealFeatures(deal: Deal, activities: readonly Activity[], asOf: Date, industry?: string): DealFeatures {
  const t = asOf.getTime();
  const mine = activities.filter((a) => a.dealId === deal.id && Date.parse(a.at) <= t);
  const f: DealFeatures = {
    recentContact: mine.some((a) => t - Date.parse(a.at) < 7 * DAY),
    stale: !mine.some((a) => t - Date.parse(a.at) < 30 * DAY),
    touches: mine.length,
    inbound: mine.filter((a) => a.inbound === true).length,
    amount: deal.amount || 0,
    market: deal.market,
  };
  if (industry) f.industry = industry;
  return f;
}

export function closedDealRows(
  deals: readonly Deal[],
  activities: readonly Activity[],
  industryOf: (companyId: string) => string | undefined = () => undefined,
): TimedRow[] {
  return deals
    .filter((d) => d.stage === "won" || d.stage === "lost")
    .map((d) => {
      const closedAt = d.stageEnteredAt || d.updatedAt;
      return {
        subject: d.id,
        t: closedAt,
        features: dealFeatures(d, activities, new Date(closedAt), industryOf(d.companyId)),
        outcome: d.stage === "won",
      };
    });
}

export type LearnedState =
  | { ready: true; model: LearnedModel; closedDeals: number; won: number; lost: number }
  | { ready: false; reason: string; closedDeals: number; won: number; lost: number };

function readiness(rows: readonly TimedRow[]): { ok: boolean; reason: string; won: number; lost: number } {
  const won = rows.filter((r) => r.outcome).length;
  const lost = rows.length - won;
  if (rows.length < MIN_CLOSED_DEALS) return { ok: false, reason: `needs ${MIN_CLOSED_DEALS} closed deals, has ${rows.length}`, won, lost };
  if (won === 0 || lost === 0) return { ok: false, reason: "needs both won and lost deals", won, lost };
  return { ok: true, reason: "", won, lost };
}

const cache = new Map<string, { key: string; state: LearnedState }>();

/** The workspace's learned model, trained on first use and whenever its closed deals change. */
export function learnedFor(
  workspace: string,
  deals: readonly Deal[],
  activities: readonly Activity[],
  industryOf?: (companyId: string) => string | undefined,
): LearnedState {
  const closed = deals.filter((d) => d.stage === "won" || d.stage === "lost");
  const key = closed.map((d) => `${d.id}:${d.stage}:${d.updatedAt}`).sort().join("|");
  const hit = cache.get(workspace);
  if (hit && hit.key === key) return hit.state;
  const rows = closedDealRows(deals, activities, industryOf);
  const r = readiness(rows);
  const state: LearnedState = r.ok
    ? { ready: true, model: train(rows), closedDeals: rows.length, won: r.won, lost: r.lost }
    : { ready: false, reason: r.reason, closedDeals: rows.length, won: r.won, lost: r.lost };
  cache.set(workspace, { key, state });
  return state;
}

/** For tests: forget every cached model. */
export function resetLearnedCache(): void {
  cache.clear();
}

export type BacktestReport =
  | ({ ready: true; closedDeals: number } & ProbabilityBacktest)
  | { ready: false; reason: string; closedDeals: number };

/** Train on older closed deals, score the newer ones, and compare with the default model. */
export function backtestReport(
  deals: readonly Deal[],
  activities: readonly Activity[],
  industryOf?: (companyId: string) => string | undefined,
  holdout = 0.3,
): BacktestReport {
  const rows = closedDealRows(deals, activities, industryOf);
  const r = readiness(rows);
  if (!r.ok) return { ready: false, reason: r.reason, closedDeals: rows.length };
  try {
    return { ready: true, closedDeals: rows.length, ...backtestProbability(rows, holdout) };
  } catch (e) {
    return { ready: false, reason: (e as Error).message, closedDeals: rows.length };
  }
}

const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export interface LearnedPrediction {
  probability: number;
  factors: { label: string; effect: number }[];
  model: string;
}

/** Stage prior from the default model, adjusted by the workspace's learned evidence. */
export function predictLearned(model: LearnedModel, stage: string, features: DealFeatures): LearnedPrediction {
  const prior = predict({ subject: "deal", features: { stage } });
  let z = logit(Math.min(0.99, Math.max(0.01, prior.probability)));
  const factors: LearnedPrediction["factors"] = [...prior.factors];
  for (const c of model.columns) {
    const v = features[c.feature];
    let x = 0;
    if (c.kind === "number") x = typeof v === "number" ? (v - c.mean!) / c.std! : 0;
    else if (c.kind === "boolean") x = v === true ? 1 : 0;
    else x = v === c.value ? 1 : 0;
    const contribution = c.weight * x;
    if (x === 0 || Math.abs(contribution) < 1e-3) continue;
    z += contribution;
    const name = c.feature.charAt(0).toUpperCase() + c.feature.slice(1);
    factors.push({ label: c.kind === "category" ? `${name}: ${c.value}` : name, effect: Math.round(Math.exp(contribution) * 100) / 100 });
  }
  return { probability: Math.min(0.97, Math.max(0.01, sigmoid(z))), factors, model: LEARNED_MODEL };
}

export function industryLookup(companies: Iterable<Company>): (companyId: string) => string | undefined {
  const m = new Map<string, string | undefined>();
  for (const c of companies) m.set(c.id, c.industry);
  return (id) => m.get(id);
}
