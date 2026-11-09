/**
 * Mesh scenario: N nodes scattered at random, a share of them offline at any moment,
 * messages sent between pairs that are far apart in hops. Used by the M1 exit test and `pnpm sim`.
 */
import { createIdentity } from "../identity.ts";
import { MeshNode } from "../node.ts";
import { SimNetwork, mulberry32, type SimTransport } from "./network.ts";

export interface ScenarioOptions {
  nodes?: number;
  seed?: number;
  /** Radio range as a share of the area's side. */
  range?: number;
  /** Share of nodes offline at any moment, re-drawn every churn interval. */
  churn?: number;
  churnIntervalMs?: number;
  messages?: number;
  /** Only pick sender/recipient pairs at least this many hops apart (in the full graph). */
  minHops?: number;
  /** Window over which messages are sent. */
  sendWindowMs?: number;
  /** Total simulated time. */
  durationMs?: number;
  lossRate?: number;
  ttl?: number;
}

export interface ScenarioResult {
  nodes: number;
  messages: number;
  delivered: number;
  receipts: number;
  deliveryRate: number;
  receiptRate: number;
  /** Shortest-path hops between pairs in the full graph. */
  pairHops: { min: number; max: number; mean: number };
  meanDeliveryMs: number;
  p95DeliveryMs: number;
  frames: number;
  graphDiameter: number;
}

const DEFAULTS: Required<ScenarioOptions> = {
  nodes: 100,
  seed: 7,
  range: 0.17,
  churn: 0.2,
  churnIntervalMs: 120_000,
  messages: 100,
  minHops: 6,
  sendWindowMs: 10 * 60_000,
  durationMs: 60 * 60_000,
  lossRate: 0.02,
  ttl: 16,
};

export function runScenario(options: ScenarioOptions = {}): ScenarioResult {
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as ScenarioOptions;
  const o: Required<ScenarioOptions> = { ...DEFAULTS, ...given };
  const rand = mulberry32(o.seed);

  // Place nodes until the full graph is connected, so every pair is reachable in principle.
  let net: SimNetwork;
  let dist: number[][];
  let attempt = 0;
  for (;;) {
    net = new SimNetwork({ range: o.range, seed: o.seed + attempt * 7919, lossRate: o.lossRate });
    for (let i = 0; i < o.nodes; i++) net.add(rand(), rand());
    dist = allPairsHops(net);
    if (dist.every((row) => row.every((d) => d !== Infinity))) break;
    if (++attempt > 50) throw new Error("could not place a connected graph; raise range");
  }

  const graphDiameter = Math.max(...dist.map((row) => Math.max(...row)));
  const nodes = net.transports.map((t) => new MeshNode(createIdentity(), t, { now: net.now, defaultTtl: o.ttl }));

  // Choose far-apart pairs.
  const pairs: [number, number][] = [];
  const candidates: [number, number][] = [];
  for (let a = 0; a < o.nodes; a++) for (let b = 0; b < o.nodes; b++) if (dist[a]![b]! >= o.minHops) candidates.push([a, b]);
  if (!candidates.length) throw new Error(`no pairs ${o.minHops}+ hops apart; lower range`);
  for (let i = 0; i < o.messages; i++) pairs.push(candidates[Math.floor(rand() * candidates.length)]!);

  const sentAt = new Map<string, number>();
  const deliveredAt = new Map<string, number>();
  let receipts = 0;
  nodes.forEach((n) => {
    n.onMessage((m) => {
      if (!deliveredAt.has(m.msgId)) deliveredAt.set(m.msgId, net.time);
    });
    n.onReceipt(() => receipts++);
  });

  const start = net.time;
  const churn = (online: (t: SimTransport) => boolean) => net.transports.forEach((t) => net.setOnline(t, online(t)));
  const reroll = () => churn(() => net.random() >= o.churn);
  reroll();
  for (let t = o.churnIntervalMs; t < o.durationMs; t += o.churnIntervalMs) net.schedule(t, reroll);

  pairs.forEach(([a, b], i) => {
    const at = (o.sendWindowMs * i) / o.messages;
    net.schedule(at, () => {
      const id = nodes[a]!.send(nodes[b]!.identity.publicKey, new TextEncoder().encode(`msg ${i}`));
      sentAt.set(id, net.time);
    });
  });

  net.runUntil(start + o.durationMs);

  const latencies = [...deliveredAt].map(([id, at]) => at - (sentAt.get(id) ?? at)).sort((x, y) => x - y);
  const hops = pairs.map(([a, b]) => dist[a]![b]!);
  return {
    nodes: o.nodes,
    messages: o.messages,
    delivered: deliveredAt.size,
    receipts,
    deliveryRate: deliveredAt.size / o.messages,
    receiptRate: receipts / o.messages,
    pairHops: { min: Math.min(...hops), max: Math.max(...hops), mean: hops.reduce((s, h) => s + h, 0) / hops.length },
    meanDeliveryMs: latencies.length ? latencies.reduce((s, l) => s + l, 0) / latencies.length : 0,
    p95DeliveryMs: latencies.length ? latencies[Math.floor(latencies.length * 0.95)]! : 0,
    frames: net.frames,
    graphDiameter,
  };
}

function allPairsHops(net: SimNetwork): number[][] {
  const ts = net.transports;
  const adj = ts.map((t) => net.neighbours(t).map((o) => o.index));
  return ts.map((_, s) => {
    const d = new Array<number>(ts.length).fill(Infinity);
    d[s] = 0;
    const q = [s];
    for (let i = 0; i < q.length; i++) {
      const u = q[i]!;
      for (const v of adj[u]!) if (d[v] === Infinity) {
        d[v] = d[u]! + 1;
        q.push(v);
      }
    }
    return d;
  });
}
