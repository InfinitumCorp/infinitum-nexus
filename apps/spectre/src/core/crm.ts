import { randomUUID } from "node:crypto";
import type { AgentProposal, AgentRunRecord } from "./agent-team.ts";
import type { Simulation } from "@infinitum/conjure";
import type { SmartList, Form, FormSubmission, Calendar, Appointment, Workflow, WorkflowJob, Message } from "./growth-model.ts";
import type { Ledger, Signer, Entry } from "@infinitum/firmament";
import {
  STAGES,
  OPEN_STAGES,
  type Activity,
  type Company,
  type Contact,
  type Deal,
  type Fact,
  type Relationship,
  type Stage,
} from "./model.ts";

/**
 * +SPCTR record store. Every create, change and merge is written to Firmament Network
 * ("Firmament Network records where each fact came from and who changed what").
 * Personal details (emails, phones) never go on the ledger; only which fields changed.
 */

export class SpectreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const PERSONAL_FIELDS = new Set(["email", "phone", "name", "title", "fields"]);

export interface SpectreStore {
  companies: Map<string, Company>;
  contacts: Map<string, Contact>;
  deals: Map<string, Deal>;
  activities: Map<string, Activity>;
  relationships: Map<string, Relationship>;
  /** SCALVS.ai agent proposals awaiting (or past) human approval. */
  proposals: Map<string, AgentProposal>;
  /** Recent agent runs, for the Agents page history. */
  agentRuns: Map<string, AgentRunRecord>;
  smartLists: Map<string, SmartList>;
  forms: Map<string, Form>;
  submissions: Map<string, FormSubmission>;
  calendars: Map<string, Calendar>;
  appointments: Map<string, Appointment>;
  workflows: Map<string, Workflow>;
  jobs: Map<string, WorkflowJob>;
  messages: Map<string, Message>;
  /** Conjure swarm simulations (SCALVS.ai), tagged with their workspace. */
  simulations: Map<string, Simulation & { workspace: string; dealId?: string; createdBy: string }>;
}

export const emptyStore = (): SpectreStore => ({
  companies: new Map(),
  contacts: new Map(),
  deals: new Map(),
  activities: new Map(),
  relationships: new Map(),
  proposals: new Map(),
  agentRuns: new Map(),
  smartLists: new Map(),
  forms: new Map(),
  submissions: new Map(),
  calendars: new Map(),
  appointments: new Map(),
  workflows: new Map(),
  jobs: new Map(),
  messages: new Map(),
  simulations: new Map(),
});

type Kind = "company" | "contact" | "deal" | "activity" | "relationship";

export class SpectreCRM {
  readonly store: SpectreStore;
  private readonly ledger: Ledger;
  private readonly signer: Signer;
  private readonly clock: () => Date;

  constructor(opts: { ledger: Ledger; signer: Signer; store?: SpectreStore; clock?: () => Date }) {
    this.ledger = opts.ledger;
    this.signer = opts.signer;
    this.store = opts.store ?? emptyStore();
    this.clock = opts.clock ?? (() => new Date());
  }

  now() {
    return this.clock();
  }

  private stamp() {
    return this.now().toISOString();
  }

  private audit(actor: string, kind: Kind, id: string, payload: Record<string, unknown>, type: Entry["type"] = "audit") {
    return this.ledger.append({ type, product: "spectre", actor, subject: `${kind}:${id}`, payload }, this.signer);
  }

  /** Field names changed, with personal values redacted from the audit trail. */
  private diff(before: object, after: object) {
    const changes: Record<string, unknown> = {};
    const b = before as Record<string, unknown>;
    const a = after as Record<string, unknown>;
    for (const k of Object.keys(a)) {
      if (k === "updatedAt" || JSON.stringify(b[k]) === JSON.stringify(a[k])) continue;
      changes[k] = PERSONAL_FIELDS.has(k) ? "[changed]" : a[k];
    }
    return changes;
  }

  private get<T extends { workspace: string }>(map: Map<string, T>, id: string, workspace: string, what: string): T {
    const item = map.get(id);
    if (!item || item.workspace !== workspace) throw new SpectreError("not_found", `${what} not found`);
    return item;
  }

  /* ---------------- Companies & agencies ---------------- */

  async addCompany(workspace: string, actor: string, input: Pick<Company, "name"> & Partial<Pick<Company, "domain" | "kind" | "industry" | "headcount">>) {
    if (!input.name.trim()) throw new SpectreError("invalid", "Company name is required");
    const t = this.stamp();
    const c: Company = {
      id: `co_${randomUUID()}`,
      workspace,
      name: input.name.trim(),
      domain: input.domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""),
      kind: input.kind ?? "company",
      industry: input.industry,
      headcount: input.headcount,
      facts: [],
      createdAt: t,
      updatedAt: t,
    };
    this.store.companies.set(c.id, c);
    await this.audit(actor, "company", c.id, { event: "created", name: c.name, domain: c.domain ?? null });
    return c;
  }

  company(workspace: string, id: string) {
    return this.get(this.store.companies, id, workspace, "Company");
  }

  async updateCompany(workspace: string, actor: string, id: string, patch: Partial<Pick<Company, "name" | "domain" | "kind" | "industry" | "headcount">>) {
    const c = this.company(workspace, id);
    const next = { ...c, ...patch, updatedAt: this.stamp() };
    const changes = this.diff(c, next);
    this.store.companies.set(id, next);
    if (Object.keys(changes).length) await this.audit(actor, "company", id, { event: "updated", changes });
    return next;
  }

  /** Record a researched fact with its source; provenance goes to Firmament. */
  async addFact(workspace: string, actor: string, companyId: string, fact: Omit<Fact, "id" | "observedAt"> & { observedAt?: string }) {
    const c = this.company(workspace, companyId);
    const f: Fact = { id: `fact_${randomUUID()}`, observedAt: fact.observedAt ?? this.stamp(), field: fact.field, value: fact.value, source: fact.source };
    c.facts.push(f);
    c.updatedAt = this.stamp();
    await this.audit(actor, "company", companyId, { event: "fact.added", fact: f.id, field: f.field, source: f.source }, "provenance");
    return f;
  }

  /* ---------------- Contacts ---------------- */

  async addContact(workspace: string, actor: string, input: Pick<Contact, "name"> & Partial<Omit<Contact, "id" | "workspace" | "createdAt" | "updatedAt">>) {
    if (!input.name.trim()) throw new SpectreError("invalid", "Contact name is required");
    if (input.companyId) this.company(workspace, input.companyId);
    const email = input.email?.trim().toLowerCase();
    if (email && this.isSuppressed(workspace, email)) {
      throw new SpectreError("opted_out", "This person opted out; Spectre honors opt-outs");
    }
    const t = this.stamp();
    const c: Contact = { ...input, id: `ct_${randomUUID()}`, workspace, name: input.name.trim(), email, createdAt: t, updatedAt: t };
    this.store.contacts.set(c.id, c);
    await this.audit(actor, "contact", c.id, { event: "created", company: c.companyId ?? null });
    return c;
  }

  contact(workspace: string, id: string) {
    return this.get(this.store.contacts, id, workspace, "Contact");
  }

  async updateContact(workspace: string, actor: string, id: string, patch: Partial<Omit<Contact, "id" | "workspace" | "createdAt" | "updatedAt">>) {
    const c = this.contact(workspace, id);
    const next = { ...c, ...patch, email: patch.email?.trim().toLowerCase() ?? c.email, updatedAt: this.stamp() };
    const changes = this.diff(c, next);
    this.store.contacts.set(id, next);
    if (Object.keys(changes).length) await this.audit(actor, "contact", id, { event: "updated", changes });
    return next;
  }

  /** Opt-out: personal details are erased; only a suppression marker remains so they're never re-added. */
  async optOut(workspace: string, actor: string, id: string) {
    const c = this.contact(workspace, id);
    const suppressed: Contact = { id, workspace, name: "Opted out", email: c.email, optedOut: true, createdAt: c.createdAt, updatedAt: this.stamp() };
    this.store.contacts.set(id, suppressed);
    await this.audit(actor, "contact", id, { event: "opted_out" });
  }

  private isSuppressed(workspace: string, email: string) {
    for (const c of this.store.contacts.values()) if (c.workspace === workspace && c.optedOut && c.email === email) return true;
    return false;
  }

  /* ---------------- Deals ---------------- */

  async addDeal(workspace: string, actor: string, input: Pick<Deal, "companyId" | "name" | "amount" | "closeDate"> & Partial<Pick<Deal, "market" | "stage" | "currency" | "contactIds" | "ownerCid">>) {
    this.company(workspace, input.companyId);
    if (!(input.amount >= 0)) throw new SpectreError("invalid", "Amount must be zero or more");
    if (Number.isNaN(Date.parse(input.closeDate))) throw new SpectreError("invalid", "Close date is not a date");
    for (const id of input.contactIds ?? []) this.contact(workspace, id);
    const t = this.stamp();
    const d: Deal = {
      id: `dl_${randomUUID()}`,
      workspace,
      companyId: input.companyId,
      name: input.name.trim(),
      market: input.market ?? "commercial",
      stage: input.stage ?? "lead",
      amount: input.amount,
      currency: input.currency ?? "USD",
      closeDate: input.closeDate,
      ownerCid: input.ownerCid ?? actor,
      contactIds: input.contactIds ?? [],
      stageEnteredAt: t,
      createdAt: t,
      updatedAt: t,
    };
    this.store.deals.set(d.id, d);
    await this.audit(actor, "deal", d.id, { event: "created", stage: d.stage, amount: d.amount, currency: d.currency });
    return d;
  }

  deal(workspace: string, id: string) {
    return this.get(this.store.deals, id, workspace, "Deal");
  }

  async moveDeal(workspace: string, actor: string, id: string, stage: Stage, lostReason?: string) {
    if (!STAGES.includes(stage)) throw new SpectreError("invalid", "Unknown stage");
    const d = this.deal(workspace, id);
    if (d.stage === stage) return d;
    if (stage === "lost" && !lostReason) throw new SpectreError("invalid", "Say why the deal was lost; it improves forecasts");
    const from = d.stage;
    const t = this.stamp();
    const closing = stage === "won" || stage === "lost";
    const closedFrom = closing ? (OPEN_STAGES.includes(from) ? from : d.closedFrom) : undefined;
    const next: Deal = { ...d, stage, stageEnteredAt: t, updatedAt: t, lostReason: stage === "lost" ? lostReason : undefined, closedFrom };
    this.store.deals.set(id, next);
    await this.audit(actor, "deal", id, { event: "stage_changed", from, to: stage, lostReason: lostReason ?? null });
    return next;
  }

  async updateDeal(workspace: string, actor: string, id: string, patch: Partial<Pick<Deal, "name" | "amount" | "closeDate" | "market" | "contactIds" | "ownerCid">>) {
    const d = this.deal(workspace, id);
    for (const cid of patch.contactIds ?? []) this.contact(workspace, cid);
    const next = { ...d, ...patch, updatedAt: this.stamp() };
    const changes = this.diff(d, next);
    this.store.deals.set(id, next);
    if (Object.keys(changes).length) await this.audit(actor, "deal", id, { event: "updated", changes });
    return next;
  }

  /* ---------------- Activities ---------------- */

  async logActivity(workspace: string, actor: string, input: Omit<Activity, "id" | "workspace" | "actorCid" | "at" | "contactIds"> & { at?: string; contactIds?: string[] }) {
    if (input.dealId) this.deal(workspace, input.dealId);
    if (input.companyId) this.company(workspace, input.companyId);
    const contactIds = input.contactIds ?? [];
    for (const id of contactIds) this.contact(workspace, id);
    const a: Activity = { ...input, contactIds, id: `ac_${randomUUID()}`, workspace, at: input.at ?? this.stamp(), actorCid: actor };
    if (!a.companyId && a.dealId) a.companyId = this.deal(workspace, a.dealId).companyId;
    this.store.activities.set(a.id, a);
    await this.audit(actor, "activity", a.id, { event: "logged", kind: a.kind, deal: a.dealId ?? null });
    return a;
  }

  async completeTask(workspace: string, actor: string, id: string) {
    const a = this.get(this.store.activities, id, workspace, "Task");
    if (a.kind !== "task") throw new SpectreError("invalid", "Only tasks can be completed");
    a.done = true;
    await this.audit(actor, "activity", id, { event: "task.completed" });
    return a;
  }

  /* ---------------- Relationships ---------------- */

  async relate(workspace: string, actor: string, from: string, to: string, strength: Relationship["strength"], note?: string) {
    for (const end of [from, to]) if (!end.startsWith("cid:") && !end.startsWith("cid_")) this.contact(workspace, end);
    if (from === to) throw new SpectreError("invalid", "A person can't be related to themselves");
    const r: Relationship = { id: `rl_${randomUUID()}`, workspace, from, to, strength, note };
    this.store.relationships.set(r.id, r);
    await this.audit(actor, "relationship", r.id, { event: "created", strength });
    return r;
  }

  /* ---------------- Queries ---------------- */

  list<K extends keyof SpectreStore>(kind: K, workspace: string): (SpectreStore[K] extends Map<string, infer V> ? V : never)[] {
    return [...this.store[kind].values()].filter((v) => v.workspace === workspace) as never;
  }

  activitiesFor(workspace: string, filter: { dealId?: string; companyId?: string; contactId?: string }) {
    return this.list("activities", workspace)
      .filter((a) =>
        (!filter.dealId || a.dealId === filter.dealId) &&
        (!filter.companyId || a.companyId === filter.companyId) &&
        (!filter.contactId || a.contactIds.includes(filter.contactId)))
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Every recorded change to a record, from Firmament: who changed what, and when. */
  history(kind: Kind, id: string) {
    return this.ledger.query({ product: "spectre", subject: `${kind}:${id}` });
  }

  /** Firmament record for the growth features (forms, bookings, automations, messages). */
  async record(actor: string, subject: string, payload: Record<string, unknown>, type: Entry["type"] = "audit") {
    await this.ledger.append({ type, product: "spectre", actor, subject, payload }, this.signer);
  }

  /** Firmament record of SCALVS.ai agent activity (runs, approvals, dismissals). */
  async auditAgent(actor: string, agentId: string, payload: Record<string, unknown>) {
    await this.ledger.append({ type: "audit", product: "spectre", actor, subject: `agent:${agentId}`, payload }, this.signer);
  }

  /** Used by data cleaning when merging duplicates. */
  async recordMerge(actor: string, kind: "company" | "contact", keptId: string, mergedIds: string[]) {
    await this.audit(actor, kind, keptId, { event: "merged", merged: mergedIds });
  }
}
