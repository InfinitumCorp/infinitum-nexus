/**
 * Optional METATRON-backed scorer.
 * When METATRON is available, Spectre can use it instead of the baseline.
 */
import { predict, type Prediction } from "@infinitum/metatron";
import type { Deal, Activity } from "./model.ts";
import type { Score } from "./intelligence.ts";

export function scoreWithMetatron(deal: Deal, activities: Activity[], now: Date): Score {
  const recent = activities.some((a) => a.dealId === deal.id && now.getTime() - Date.parse(a.at) < 7 * 86400000);
  const stale = !activities.some((a) => a.dealId === deal.id && now.getTime() - Date.parse(a.at) < 30 * 86400000);

  const pred: Prediction = predict({
    subject: deal.id,
    features: {
      stage: deal.stage,
      recentContact: recent,
      stale,
      amount: deal.amount,
    },
  });

  return {
    dealId: deal.id,
    probability: pred.probability,
    base: 0.25,
    factors: pred.factors.map((f) => ({ label: f.label, effect: f.effect })),
    risk: pred.probability < 0.3 ? "high" : pred.probability < 0.6 ? "medium" : "low",
  };
}
