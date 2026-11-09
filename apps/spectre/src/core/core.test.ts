import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Ledger, generateSigner } from "@infinitum/firmament";
import { SpectreCRM, SpectreError } from "./crm.ts";
import { scoreDeal, nextBestAction, forecast, riskAlerts, learnStageRates, type Score } from "./intelligence.ts";
import { warmestPath, committeeGaps } from "./relationships.ts";
import { findDuplicateCompanies, findDuplicateContacts, mergeContactFields, dataIssues, similarity } from "./cleaning.ts";
import type { Deal } from "./model.ts";

const WS = "cid_workspace";
const ME = "cid_me";
const DAY = 86_400_000;

function setup(start = new Date("2026-11-04T12:00:00Z")) {
  let now = start;
  const signer = generateSigner();
  const ledger = new Ledger(undefined, { authorizedSigners: [signer.publicKey] });
  const crm = new SpectreCRM({ ledger, signer, clock: () => now });
  return { crm, ledger, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, now: () => now };
}

const rejectsWith = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => e instanceof SpectreError && e.code === code);

describe("+SPCTR records and audit trail", () => {
  it("records every change on Firmament without personal details", async () => {
    const { crm, ledger } = setup();
    const co = await crm.addCompany(WS, ME, { name: "Northwind Logistics", domain: "https://www.northwind.example/about" });
    assert.equal(co.domain, "northwind.example");
    const ct = await crm.addContact(WS, ME, { name: "Dana Ruiz", email: "Dana@Northwind.example", companyId: co.id });
    assert.equal(ct.email, "dana@northwind.example");
    await crm.updateContact(WS, ME, ct.id, { phone: "+1 202 555 0101", title: "COO" });

    const history = await crm.history("contact", ct.id);
    assert.deepEqual(history.map((h) => h.payload.event), ["created", "updated"]);
    assert.deepEqual(history[1].payload.changes, { phone: "[changed]", title: "[changed]" });
    const all = JSON.stringify(await ledger.entries());
    assert.ok(!all.includes("dana@") && !all.includes("555 0101"), "personal details stay off the ledger");
    assert.equal((await ledger.verify()).ok, true);
  });

  it("records where each researched fact came from", async () => {
    const { crm } = setup();
    const co = await crm.addCompany(WS, ME, { name: "Northwind" });
    await crm.addFact(WS, "agent:researcher", co.id, { field: "funding", value: "Series B, $40M", source: "https://news.example/northwind-series-b" });
    const [h] = (await crm.history("company", co.id)).filter((e) => e.type === "provenance");
    assert.equal(h.actor, "agent:researcher");
    assert.equal(h.payload.source, "https://news.example/northwind-series-b");
  });

  it("keeps workspaces apart", async () => {
    const { crm } = setup();
    const co = await crm.addCompany(WS, ME, { name: "Northwind" });
    assert.throws(() => crm.company("cid_someone_else", co.id), /not found/);
    assert.equal(crm.list("companies", "cid_someone_else").length, 0);
  });

  it("requires a reason when a deal is lost, and tracks stage changes", async () => {
    const { crm } = setup();
    const co = await crm.addCompany(WS, ME, { name: "Northwind" });
    const d = await crm.addDeal(WS, ME, { companyId: co.id, name: "Fleet rollout", amount: 120000, closeDate: "2026-12-15" });
    await crm.moveDeal(WS, ME, d.id, "proposal");
    await rejectsWith(crm.moveDeal(WS, ME, d.id, "lost"), "invalid");
    const lost = await crm.moveDeal(WS, ME, d.id, "lost", "Chose incumbent vendor");
    assert.equal(lost.closedFrom, "proposal");
    assert.equal((await crm.moveDeal(WS, ME, d.id, "won")).closedFrom, "proposal");
    assert.equal((await crm.moveDeal(WS, ME, d.id, "negotiation")).closedFrom, undefined);
    const events = (await crm.history("deal", d.id)).map((e) => e.payload);
    assert.deepEqual(events.slice(1).map((e) => [e.from, e.to]), [["lead", "proposal"], ["proposal", "lost"], ["lost", "won"], ["won", "negotiation"]]);
  });

  it("honors opt-outs: erases details and blocks re-adding", async () => {
    const { crm } = setup();
    const ct = await crm.addContact(WS, ME, { name: "Lee Park", email: "lee@park.example", phone: "123" });
    await crm.optOut(WS, ME, ct.id);
    const after = crm.contact(WS, ct.id);
    assert.equal(after.name, "Opted out");
    assert.equal(after.phone, undefined);
    await rejectsWith(crm.addContact(WS, ME, { name: "Lee P.", email: "LEE@park.example" }), "opted_out");
  });
});

describe("+SPCTR predictive pipeline", () => {
  async function dealWith(crm: SpectreCRM, stage: Deal["stage"], opts: { contacts?: number; closeDate?: string } = {}) {
    const co = await crm.addCompany(WS, ME, { name: `Co ${Math.random()}` });
    const contactIds: string[] = [];
    for (let i = 0; i < (opts.contacts ?? 2); i++) contactIds.push((await crm.addContact(WS, ME, { name: `Person ${i}`, companyId: co.id })).id);
    const d = await crm.addDeal(WS, ME, { companyId: co.id, name: "Deal", amount: 100000, closeDate: opts.closeDate ?? "2026-12-20", contactIds, stage });
    return d;
  }

  it("scores an engaged deal above a neglected one, and shows why", async () => {
    const { crm, now, advance } = setup();
    const healthy = await dealWith(crm, "proposal", { contacts: 3 });
    const neglected = await dealWith(crm, "proposal", { contacts: 1 });
    await crm.logActivity(WS, ME, { kind: "meeting", summary: "Kickoff", dealId: healthy.id, at: new Date(now().getTime() - 20 * DAY).toISOString() });
    await crm.logActivity(WS, ME, { kind: "meeting", summary: "Demo", dealId: healthy.id, at: new Date(now().getTime() - 5 * DAY).toISOString() });
    await crm.logActivity(WS, ME, { kind: "email", summary: "Questions on pricing", dealId: healthy.id, inbound: true, at: new Date(now().getTime() - 3 * DAY).toISOString() });
    await crm.logActivity(WS, ME, { kind: "email", summary: "Legal review started", dealId: healthy.id, inbound: true, at: new Date(now().getTime() - 1 * DAY).toISOString() });
    await crm.logActivity(WS, ME, { kind: "email", summary: "Sent proposal", dealId: neglected.id, at: new Date(now().getTime() - 40 * DAY).toISOString() });
    advance(0);

    const acts = crm.list("activities", WS);
    const h = scoreDeal(crm.deal(WS, healthy.id), acts, now());
    const n = scoreDeal(crm.deal(WS, neglected.id), acts, now());
    assert.ok(h.probability > 0.4, `healthy ${h.probability}`);
    assert.ok(n.probability < 0.25, `neglected ${n.probability}`);
    assert.equal(n.risk, "high");
    assert.ok(n.factors.some((f) => f.label.startsWith("No contact in 40 days")));
    assert.ok(h.factors.some((f) => f.label.includes("reached out 2 times")));
  });

  it("recommends the next best action with its reason", async () => {
    const { crm, now } = setup();
    const late = await dealWith(crm, "negotiation", { contacts: 1, closeDate: "2026-10-01" });
    const acts = crm.list("activities", WS);
    const s = scoreDeal(late, acts, now());
    const nba = nextBestAction(late, s, acts, now());
    assert.equal(nba.action, "Confirm a new close date with the buyer");
    assert.match(nba.why, /Close date passed 35 days ago/);
    assert.equal(nba.priority, 1);
  });

  it("puts overdue promised follow-ups first", async () => {
    const { crm, now } = setup();
    const d = await dealWith(crm, "discovery");
    await crm.logActivity(WS, ME, { kind: "task", summary: "Send security questionnaire", dealId: d.id, dueAt: "2026-11-01T00:00:00Z" });
    const acts = crm.list("activities", WS);
    assert.match(nextBestAction(d, scoreDeal(d, acts, now()), acts, now()).action, /security questionnaire/);
  });

  it("forecasts committed, weighted and best-case revenue by month", async () => {
    const { crm, now } = setup();
    const a = await dealWith(crm, "won", { closeDate: "2026-11-20" });
    const b = await dealWith(crm, "proposal", { closeDate: "2026-11-25" });
    const c = await dealWith(crm, "negotiation", { closeDate: "2026-12-10" });
    const deals = [a, b, c].map((d) => crm.deal(WS, d.id));
    const scores = new Map<string, Score>([[b.id, { dealId: b.id, probability: 0.5, base: 0.4, factors: [], risk: "low" }], [c.id, { dealId: c.id, probability: 0.6, base: 0.6, factors: [], risk: "low" }]]);
    const f = forecast(deals, scores, 3, now());
    assert.deepEqual(f.map((p) => p.period), ["2026-11", "2026-12", "2027-01"]);
    assert.deepEqual([f[0].committed, f[0].weighted, f[0].bestCase], [100000, 50000, 200000]);
    assert.equal(f[1].weighted, 60000);
  });

  it("raises risk alerts, worst first", async () => {
    const { crm, now } = setup();
    const bad = await dealWith(crm, "negotiation", { contacts: 1, closeDate: "2026-09-01" });
    const ok = await dealWith(crm, "lead");
    const acts = crm.list("activities", WS);
    const scores = new Map([bad, ok].map((d) => [d.id, scoreDeal(d, acts, now())]));
    const alerts = riskAlerts([bad, ok], scores);
    assert.equal(alerts[0].dealId, bad.id);
    assert.equal(alerts[0].severity, "high");
  });

  it("uses industry priors until there's enough history, then learns", () => {
    const priors = learnStageRates([]);
    assert.equal(priors.proposal, 0.4);
    const closed = Array.from({ length: 30 }, (_, i) => ({ stage: i < 24 ? "won" : "lost", stagesVisited: ["lead", "qualified", "discovery", "proposal", "negotiation"] })) as never[];
    assert.ok(learnStageRates(closed).proposal > 0.6);
  });
});

describe("+SPCTR relationship intelligence", () => {
  it("finds the warmest path into an account", async () => {
    const { crm } = setup();
    const target = await crm.addCompany(WS, ME, { name: "Ministry of Transport", kind: "agency" });
    const other = await crm.addCompany(WS, ME, { name: "Partner Co" });
    const director = await crm.addContact(WS, ME, { name: "Director", companyId: target.id, influence: "decision-maker" });
    const analyst = await crm.addContact(WS, ME, { name: "Analyst", companyId: target.id, influence: "influencer" });
    const friend = await crm.addContact(WS, ME, { name: "Old colleague", companyId: other.id });
    await crm.relate(WS, ME, "cid:me", analyst.id, 1); // weak: met once
    await crm.relate(WS, ME, "cid:me", friend.id, 5); // close friend
    await crm.relate(WS, ME, friend.id, director.id, 5); // who works closely with the director

    const path = warmestPath(["cid:me"], target.id, crm.list("contacts", WS), crm.list("relationships", WS));
    assert.ok(path);
    assert.equal(path.target, director.id);
    assert.equal(path.steps.length, 2);
    assert.equal(path.warmth, 1);
  });

  it("flags gaps in the buying committee", async () => {
    const { crm } = setup();
    const co = await crm.addCompany(WS, ME, { name: "Acme" });
    await crm.addContact(WS, ME, { name: "Procurement lead", companyId: co.id, influence: "blocker" });
    assert.deepEqual(committeeGaps(co.id, crm.list("contacts", WS)), ["No decision-maker identified", "No champion identified", "1 blocker to win over"]);
  });
});

describe("+SPCTR self-cleaning data", () => {
  it("finds duplicate companies by website and by name", async () => {
    const { crm } = setup();
    await crm.addCompany(WS, ME, { name: "Northwind Logistics Inc.", domain: "northwind.example" });
    await crm.addCompany(WS, ME, { name: "Northwind", domain: "www.northwind.example" });
    await crm.addCompany(WS, ME, { name: "Contoso Ltd" });
    await crm.addCompany(WS, ME, { name: "Contoso" });
    await crm.addCompany(WS, ME, { name: "Fabrikam" });
    const groups = findDuplicateCompanies(crm.list("companies", WS));
    assert.equal(groups.length, 2);
    assert.equal(groups[0].reason, "Same website (northwind.example)");
  });

  it("finds duplicate contacts and merges their details", async () => {
    const { crm } = setup();
    const co = await crm.addCompany(WS, ME, { name: "Acme" });
    await crm.addContact(WS, ME, { name: "José Álvarez", companyId: co.id, email: "jose@acme.example" });
    await crm.addContact(WS, ME, { name: "Jose Alvarez", companyId: co.id, phone: "+1 555 0100", title: "CFO" });
    const [g] = findDuplicateContacts(crm.list("contacts", WS));
    assert.equal(g.reason, "Same name at the same company");
    const merged = mergeContactFields(g.keep, g.duplicates);
    assert.equal(merged.email, "jose@acme.example");
    assert.equal(merged.title, "CFO");
  });

  it("flags stale contacts and missing fields", async () => {
    const { crm, advance, now } = setup();
    await crm.addContact(WS, ME, { name: "Quiet Person", email: "q@x.example" });
    advance(200 * DAY);
    const issues = dataIssues(crm.list("contacts", WS), [], crm.list("activities", WS), now());
    assert.equal(issues[0].kind, "stale_contact");
  });

  it("scores name similarity sensibly", () => {
    assert.ok(similarity("northwind logistics", "northwind logistic") > 0.9);
    assert.ok(similarity("northwind", "contoso") < 0.3);
  });
});
