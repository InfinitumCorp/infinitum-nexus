import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { backtestReport, closedDealRows, learnedFor, MIN_CLOSED_DEALS, resetLearnedCache, LEARNED_MODEL } from "./metatron-learned.ts";
import { learnedContextFor, scoreDealMetatron } from "./intelligence-metatron.ts";
import type { Activity, Deal } from "./model.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");

function deal(i: number, stage: Deal["stage"], at: number): Deal {
  const iso = new Date(at).toISOString();
  return {
    id: `d${i}`, workspace: "ws", companyId: "c1", name: `Deal ${i}`, market: "commercial", stage, amount: 10_000 + i * 100,
    currency: "USD", closeDate: iso.slice(0, 10), ownerCid: "me", contactIds: [], stageEnteredAt: iso, createdAt: iso, updatedAt: iso,
  };
}

function act(dealId: string, at: number, inbound: boolean): Activity {
  return { id: `a-${dealId}-${at}`, workspace: "ws", kind: "email", at: new Date(at).toISOString(), summary: "", dealId, contactIds: [], inbound, actorCid: "me" };
}

/** History where deals with customer replies mostly win and silent ones mostly lose. */
function history(n: number): { deals: Deal[]; acts: Activity[] } {
  const deals: Deal[] = [];
  const acts: Activity[] = [];
  for (let i = 0; i < n; i++) {
    const closeAt = T0 + i * DAY;
    const replied = i % 2 === 0;
    const won = replied ? i % 10 !== 0 : i % 10 === 5;
    deals.push(deal(i, won ? "won" : "lost", closeAt));
    acts.push(act(`d${i}`, closeAt - 2 * DAY, replied));
    if (replied) acts.push(act(`d${i}`, closeAt - 4 * DAY, true));
  }
  return { deals, acts };
}

beforeEach(() => {
  resetLearnedCache();
  process.env.USE_METATRON = "1";
});

test("closed deals become training rows with features as of close", () => {
  const { deals, acts } = history(4);
  const rows = closedDealRows([...deals, deal(99, "proposal", T0)], acts);
  assert.equal(rows.length, 4);
  assert.equal(rows[0]!.features.inbound, 2);
  assert.equal(rows[0]!.features.recentContact, true);
  assert.equal(rows[1]!.features.inbound, 0);
});

test("stays on the default model below the threshold", () => {
  const { deals, acts } = history(MIN_CLOSED_DEALS - 1);
  const state = learnedFor("ws", deals, acts);
  assert.equal(state.ready, false);
  assert.match((state as { reason: string }).reason, /needs 30 closed deals/);
  assert.equal(learnedContextFor("ws", deals, acts, []), null);
  const r = backtestReport(deals, acts);
  assert.equal(r.ready, false);
});

test("needs both outcomes", () => {
  const deals = Array.from({ length: 40 }, (_, i) => deal(i, "won", T0 + i * DAY));
  assert.equal(learnedFor("ws", deals, []).ready, false);
});

test("switches to the learned model once enough deals have closed, and it learns the workspace's signal", () => {
  const { deals, acts } = history(60);
  const ctx = learnedContextFor("ws", deals, acts, []);
  assert.ok(ctx);
  const now = new Date(T0 + 70 * DAY);
  const open = [deal(100, "proposal", now.getTime()), deal(101, "proposal", now.getTime())];
  const openActs = [...acts, act("d100", now.getTime() - DAY, true), act("d100", now.getTime() - 3 * DAY, true)];
  const engaged = scoreDealMetatron(open[0]!, openActs, now, ctx);
  const silent = scoreDealMetatron(open[1]!, openActs, now, ctx);
  assert.ok(engaged.probability > silent.probability + 0.2, `${engaged.probability} vs ${silent.probability}`);
  assert.ok(engaged.factors.some((f) => f.label === "Stage: proposal"));
  assert.ok(engaged.factors.some((f) => f.label === "Inbound" && f.effect > 1));
  // The default model can't tell these deals apart.
  const d0 = scoreDealMetatron(open[0]!, openActs, now);
  const d1 = scoreDealMetatron(open[1]!, openActs.filter((a) => a.dealId !== "d100"), now);
  assert.ok(Math.abs(d0.probability - d1.probability) < 0.2);
});

test("caches the model until the closed deals change", () => {
  const { deals, acts } = history(40);
  const a = learnedFor("ws", deals, acts);
  assert.equal(learnedFor("ws", deals, acts), a);
  const more = [...deals, deal(200, "won", T0 + 300 * DAY)];
  const b = learnedFor("ws", more, acts);
  assert.notEqual(b, a);
  assert.equal(b.closedDeals, 41);
  assert.equal(b.ready && b.model.model, LEARNED_MODEL);
});

test("backtest report compares learned and default models on later deals", () => {
  const { deals, acts } = history(60);
  const r = backtestReport(deals, acts);
  assert.equal(r.ready, true);
  if (!r.ready) return;
  assert.equal(r.trainSize + r.testSize, 60);
  assert.equal(r.better, "learned");
  assert.ok(r.learned.auc > r.default.auc);
});

test("METATRON off: no learned context", () => {
  process.env.USE_METATRON = "0";
  const { deals, acts } = history(60);
  assert.equal(learnedContextFor("ws", deals, acts, []), null);
});

test("learns stage once history records the stage deals closed from", async () => {
  const { learnsStage } = await import("./metatron-learned.ts");
  // Here discovery deals close far better than the default model's stage prior expects, and negotiation far worse.
  const deals: Deal[] = [];
  for (let i = 0; i < 60; i++) {
    const from = i % 2 === 0 ? "discovery" : "negotiation";
    const won = from === "discovery" ? i % 10 !== 0 : i % 10 === 5;
    deals.push({ ...deal(i, won ? "won" : "lost", T0 + i * DAY), closedFrom: from });
  }
  const rows = closedDealRows(deals, []);
  assert.equal(rows[0]!.features.stage, "discovery");
  const ctx = learnedContextFor("ws", deals, [], []);
  assert.ok(ctx && learnsStage(ctx.model));
  const now = new Date(T0 + 70 * DAY);
  const disc = scoreDealMetatron(deal(300, "discovery", now.getTime()), [], now, ctx);
  const nego = scoreDealMetatron(deal(301, "negotiation", now.getTime()), [], now, ctx);
  assert.ok(disc.probability > nego.probability + 0.3, `${disc.probability} vs ${nego.probability}`);
  assert.ok(disc.factors.some((f) => f.label === "Stage: discovery" && f.effect > 1));
  // The default model ranks them the other way round.
  const dd = scoreDealMetatron(deal(300, "discovery", now.getTime()), [], now);
  const dn = scoreDealMetatron(deal(301, "negotiation", now.getTime()), [], now);
  assert.ok(dn.probability > dd.probability);
  const r = backtestReport(deals, []);
  assert.ok(r.ready && r.better === "learned");
});
