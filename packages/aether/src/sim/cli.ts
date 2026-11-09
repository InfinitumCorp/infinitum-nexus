/**
 * Run a mesh scenario from the command line:
 *   pnpm --filter @infinitum/aether sim -- --nodes 100 --churn 0.2 --min-hops 6 --seed 7
 */
import { parseArgs } from "node:util";
import { runScenario } from "./scenario.ts";

const { values } = parseArgs({
  options: {
    nodes: { type: "string" },
    churn: { type: "string" },
    "min-hops": { type: "string" },
    messages: { type: "string" },
    seed: { type: "string" },
    range: { type: "string" },
    loss: { type: "string" },
    ttl: { type: "string" },
  },
});
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const r = runScenario({
  nodes: num(values.nodes),
  churn: num(values.churn),
  minHops: num(values["min-hops"]),
  messages: num(values.messages),
  seed: num(values.seed),
  range: num(values.range),
  lossRate: num(values.loss),
  ttl: num(values.ttl),
});
console.log(`${r.delivered}/${r.messages} delivered (${(r.deliveryRate * 100).toFixed(1)}%), receipts ${r.receipts}`);
console.log(`pair distance ${r.pairHops.min}-${r.pairHops.max} hops (mean ${r.pairHops.mean.toFixed(1)}), graph diameter ${r.graphDiameter}`);
console.log(`delivery time mean ${(r.meanDeliveryMs / 1000).toFixed(1)} s, p95 ${(r.p95DeliveryMs / 1000).toFixed(1)} s, ${r.frames} radio frames`);
