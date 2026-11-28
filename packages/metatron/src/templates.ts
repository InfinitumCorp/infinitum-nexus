/**
 * Ready-made METATRON¹⁰⁰ scenarios: starting points for "what if?".
 *
 * Each template is a complete model plus the interventions people usually
 * want to try, so the command center can show a real comparison before
 * anyone writes a formula. Numbers are illustrative defaults to be edited,
 * not market data.
 */
import type { Intervention, ScenarioModel } from "./simulate.ts";

export interface ScenarioTemplate {
  id: string;
  title: string;
  question: string;
  model: ScenarioModel;
  interventions: Intervention[];
  /** The output to headline and to run sensitivity on. */
  focus: string;
  events?: Record<string, string>;
}

export const TEMPLATES: readonly ScenarioTemplate[] = [
  {
    id: "rate-decision",
    title: "Rate decision",
    question: "What does a central-bank rate move do to a business carrying a variable-rate loan?",
    focus: "cash",
    model: {
      name: "Rates as expected",
      steps: 24,
      stepUnit: "month",
      variables: {
        rate: { kind: "choice", options: [{ value: 5.25, weight: 0.6 }, { value: 5.0, weight: 0.25 }, { value: 5.5, weight: 0.15 }] },
        spread: { kind: "uniform", min: 2, max: 3 },
        demandElasticity: { kind: "triangular", min: 0.5, mode: 1.5, max: 3 },
        baseRevenue: { kind: "normal", mean: 120000, sd: 10000, min: 60000 },
      },
      shocks: { noise: { kind: "normal", mean: 0, sd: 0.04 } },
      state: { cash: 250000, debt: 900000 },
      derived: {
        demand: "max(0, 1 - demandElasticity * (rate - 5.25) / 100 * 10 + noise)",
        revenue: "baseRevenue * demand",
        interest: "debt * (rate + spread) / 100 / 12",
        costs: "95000",
      },
      update: {
        cash: "cash + revenue - costs - interest - 10000",
        debt: "max(0, debt - 10000)",
      },
      outputs: ["cash", "revenue", "interest"],
    },
    interventions: [
      { name: "Hike to 5.75%", description: "An unexpected 50bp hike", variables: { rate: 5.75 } },
      { name: "Cut to 4.75%", description: "A 50bp cut", variables: { rate: 4.75 } },
      { name: "Fix the loan at 7.5%", description: "Refinance to a fixed rate from month 3", derived: { interest: "debt * 7.5 / 100 / 12" }, from: 3 },
    ],
    events: { cashCrunch: "cash < 50000" },
  },
  {
    id: "supply-delay",
    title: "Supply delay",
    question: "If a key supplier slips, when do we run out of stock and how many sales do we lose?",
    focus: "lostSales",
    model: {
      name: "Supplier on time",
      steps: 26,
      stepUnit: "week",
      variables: {
        delay: { kind: "choice", options: [{ value: 0, weight: 0.8 }, { value: 2, weight: 0.15 }, { value: 4, weight: 0.05 }] },
        weeklyDemand: { kind: "normal", mean: 500, sd: 60, min: 0 },
        reorderPoint: 1500,
        orderSize: 3000,
      },
      shocks: { demandSwing: { kind: "normal", mean: 0, sd: 0.15 } },
      state: { stock: 4000, onOrder: 0, arrivesAt: 0, lostSales: 0, sold: 0 },
      derived: {
        demand: "max(0, weeklyDemand * (1 + demandSwing))",
        delivered: "onOrder > 0 && t >= arrivesAt ? onOrder : 0",
        available: "stock + delivered",
        sales: "min(available, demand)",
        reorder: "onOrder == 0 && available - sales < reorderPoint",
      },
      update: {
        stock: "available - sales",
        onOrder: "reorder ? orderSize : (delivered > 0 ? 0 : onOrder)",
        arrivesAt: "reorder ? t + 3 + delay : arrivesAt",
        lostSales: "lostSales + demand - sales",
        sold: "sold + sales",
      },
      outputs: ["stock", "lostSales", "sold"],
    },
    interventions: [
      { name: "Supplier slips 6 weeks", variables: { delay: 6 } },
      { name: "Raise reorder point to 2,500", variables: { reorderPoint: 2500 } },
      { name: "Second supplier (no delays)", variables: { delay: 0 } },
    ],
    events: { stockout: "stock <= 0" },
  },
  {
    id: "product-adoption",
    title: "Product adoption",
    question: "How fast does a launch spread through a market, and what does word of mouth add?",
    focus: "adopters",
    model: {
      name: "Launch as planned",
      steps: 24,
      stepUnit: "month",
      variables: {
        advertising: { kind: "uniform", min: 0.005, max: 0.02 },
        wordOfMouth: { kind: "triangular", min: 0.1, mode: 0.3, max: 0.5 },
        price: 20,
      },
      state: { adopters: 0, revenue: 0 },
      agents: {
        count: 1000,
        attributes: { interest: { kind: "lognormal", median: 1, sigma: 0.5 }, budget: { kind: "lognormal", median: 30, sigma: 0.6 } },
        state: { adopted: 0 },
        update: {
          adopted: "adopted == 1 ? 1 : (budget >= price ? bernoulli(clamp(interest * (advertising + wordOfMouth * mean_adopted), 0, 1)) : 0)",
        },
      },
      update: { adopters: "sum_adopted", revenue: "revenue + sum_adopted * price" },
      outputs: ["adopters", "revenue", "mean_adopted"],
    },
    interventions: [
      { name: "Double advertising", variables: { advertising: { kind: "uniform", min: 0.01, max: 0.04 } } },
      { name: "Price cut to 12", variables: { price: 12 } },
      { name: "Referral program", description: "Stronger word of mouth", variables: { wordOfMouth: { kind: "triangular", min: 0.2, mode: 0.45, max: 0.7 } } },
    ],
    events: { halfMarket: "mean_adopted >= 0.5" },
  },
  {
    id: "cash-runway",
    title: "Cash runway",
    question: "How long does the money last, and what buys the most time?",
    focus: "cash",
    model: {
      name: "Current plan",
      steps: 36,
      stepUnit: "month",
      variables: {
        growth: { kind: "normal", mean: 0.06, sd: 0.03 },
        burnGrowth: { kind: "uniform", min: 0.01, max: 0.03 },
      },
      shocks: { revenueSwing: { kind: "normal", mean: 0, sd: 0.08 } },
      state: { cash: 2000000, revenue: 40000, burn: 150000 },
      derived: { net: "revenue - burn" },
      update: {
        cash: "cash + net",
        revenue: "max(0, revenue * (1 + growth + revenueSwing))",
        burn: "burn * (1 + burnGrowth)",
      },
      outputs: ["cash", "revenue", "net"],
    },
    interventions: [
      { name: "Cut burn 20% now", state: { burn: 120000 } },
      { name: "Raise $1.5M in month 9", update: { cash: "cash + net + (t == 9 ? 1500000 : 0)" } },
      { name: "Growth slows to 3%", variables: { growth: { kind: "normal", mean: 0.03, sd: 0.02 } } },
    ],
    events: { outOfCash: "cash < 0", profitable: "net > 0" },
  },
];

export function templateById(id: string): ScenarioTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
