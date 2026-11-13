# METATRON¹⁰⁰™ engine

`@infinitum/metatron` is the prediction engine behind [mttrn.app](https://mttrn.app) and +SPCTR™. It is plain TypeScript with no runtime dependencies, so it runs the same in Node and in a Cloudflare Worker.

Every answer is a range or a chance, not a certainty.

| Module | What it does |
|---|---|
| `predict`, `learn` | Win probability. A transparent default scorer, plus a learned logistic model that explains itself in odds ratios. |
| `evaluate`, `backtest` | Brier, log loss, AUC and calibration. Time-ordered backtests. Rolling-origin forecast error. |
| `forecast` | Picks the forecaster with the lowest backtest error and gives each step a range built from that model's own past errors. |
| `signals` | `anomalies`, `changePoints` and `digest`: what just changed, ranked, with one-line headlines. |
| `simulate` | The "what if?" engine: Monte Carlo scenarios, agents, interventions, paired comparison and sensitivity. |
| `templates` | Ready-made scenarios: rate decision, supply delay, product adoption and cash runway. |

## Scenarios ("what if?")

A scenario model is JSON:

```json
{
  "steps": 12,
  "stepUnit": "month",
  "variables": { "price": { "kind": "uniform", "min": 40, "max": 60 }, "growth": { "kind": "normal", "mean": 0.05, "sd": 0.02 } },
  "shocks": { "demand": { "kind": "normal", "mean": 0, "sd": 0.03 } },
  "state": { "customers": 1000, "cash": 10000 },
  "derived": { "revenue": "customers * price", "costs": "20000 + customers * 10" },
  "update": { "customers": "max(0, customers * (1 + growth + demand))", "cash": "cash + revenue - costs" }
}
```

- **variables** are uncertain inputs, drawn once per run. A bare number is a fixed value.
- **shocks** are drawn fresh every step.
- **state** holds the stocks that carry over between steps. A start value can be a formula over the variables.
- **derived** values are computed each step, in order, so a derived value can use the ones listed before it.
- **update** says how each stock changes. Every rule reads the values from before the step.
- **agents** (optional) is a population with its own `attributes`, `state` and `update`. The world reads it through `mean_<x>`, `sum_<x>` and `agents_count`.

Distributions: `fixed`, `normal` (optional `min`/`max`), `uniform`, `triangular`, `lognormal` (median, sigma), `bernoulli`, `poisson` and `choice` (weighted values).

Formulas support numbers, names, `+ - * / % ^`, comparisons, `&& || !` and `a ? b : c`. Functions: `min max abs exp log sqrt floor ceil round pow clamp logistic`, plus the seeded random draws `uniform normal bernoulli`. There is no `eval`, no property access and no loops. Booleans are 1 and 0.

```ts
import { compare, sensitivity } from "@infinitum/metatron";

const result = compare(model, [
  { name: "Raise price", variables: { price: 70 } },
  { name: "Retention push", update: { customers: "customers * (1 + growth + demand - 0.01)" }, from: 4 },
], { runs: 1000, seed: 1, events: { broke: "cash < 0" } });
// result.scenarios[i].delta.cash → paired difference vs. baseline: mean, 90% range, chance higher
const tornado = sensitivity(model, "cash"); // inputs ranked by how much they move cash
```

Runs are seeded. The baseline and every intervention use the same draws (common random numbers), so a difference comes from the change, not from luck. Pinning one variable leaves every other draw unchanged.

The limits are in `LIMITS`. Spectre's API also gives each request a work budget (`METATRON_HTTP_WORK`, default 3M agent-steps) and lowers `runs` to fit it.

## In +SPCTR™

| Route | |
|---|---|
| `GET /api/metatron/templates` | Ready-made scenarios |
| `POST /api/metatron/simulate` | `{ model \| templateId, intervention?, runs?, seed?, events? }` |
| `POST /api/metatron/compare` | `{ model \| templateId, interventions?, sensitivity?: true \| "<output>", runs?, seed?, events? }` |
| `POST /api/metatron/forecast` | `{ values, horizon?, period?, level? }` |
| `GET /api/metatron/outlook` | `horizonDays`, `target`, `whatIfStage`, `whatIfChange` (percentage points) |
| `GET /api/metatron/signals` | Weekly series, what changed, and an 8-week bookings forecast |

The METATRON¹⁰⁰ page in the Spectre web app (`#/metatron`) puts these on one screen.

## Tests

```bash
node --test --experimental-strip-types src/*.test.ts
```
