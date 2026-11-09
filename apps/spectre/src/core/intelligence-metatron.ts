/**
 * METATRON-backed scorer for Spectre.
 * USE_METATRON=1 (the default) scores with METATRON, otherwise the baseline is used.
 * When the workspace has a learned model (see metatron-learned.ts), it is used
 * instead of the default METATRON model.
 */
import type { LearnedModel } from "@infinitum/metatron";
import { scoreDeal as baselineScore, type Score } from "./intelligence.ts";
import { dealFeatures, industryLookup, learnedFor, predictLearned } from "./metatron-learned.ts";
import type { Activity, Company, Deal } from "./model.ts";
import { scoreWithMetatron } from "./score-metatron.ts";

export interface LearnedContext {
  model: LearnedModel;
  industryOf?: (companyId: string) => string | undefined;
}

export function scoreDealMetatron(deal: Deal, activities: Activity[], now: Date, learned?: LearnedContext | null): Score {
  if (process.env.USE_METATRON !== "1") return baselineScore(deal, activities, now);
  const pred = learned
    ? predictLearned(learned.model, deal.stage, dealFeatures(deal, activities, now, learned.industryOf?.(deal.companyId)))
    : scoreWithMetatron({
        stage: deal.stage,
        recentContact: activities.some((a) => a.dealId === deal.id && now.getTime() - Date.parse(a.at) < 7 * 86_400_000),
        stale: activities.filter((a) => a.dealId === deal.id).length === 0,
        amount: deal.amount,
      });
  return {
    dealId: deal.id,
    probability: pred.probability,
    base: 0.25,
    factors: pred.factors.map((f) => ({ label: f.label, effect: f.effect })),
    risk: pred.probability < 0.3 ? "high" : pred.probability < 0.6 ? "medium" : "low",
  };
}

/** The workspace's learned context, or null while it lacks enough closed deals (or METATRON is off). */
export function learnedContextFor(workspace: string, deals: readonly Deal[], activities: readonly Activity[], companies: Iterable<Company>): LearnedContext | null {
  if (process.env.USE_METATRON !== "1") return null;
  const industryOf = industryLookup(companies);
  const state = learnedFor(workspace, deals, activities, industryOf);
  return state.ready ? { model: state.model, industryOf } : null;
}
