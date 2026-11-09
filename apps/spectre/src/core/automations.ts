/**
 * Automations: "when this happens, do these steps" — with waits.
 *
 * An event (a form submitted, a tag added, a booking, a deal moving stage) starts every
 * active workflow whose trigger matches. Each run is a job that executes steps in order
 * until it reaches a wait; waiting jobs resume when the scheduler calls `runDue`
 * (a cron trigger in hosting, a timer locally). Steps run as `automation:<id>`, so every
 * change they make is attributed on the ledger.
 *
 * Loop guard: events raised by automations carry a depth; past MAX_DEPTH they no longer
 * start workflows. A workflow never runs twice at once for the same contact or deal.
 */
import { randomUUID } from "node:crypto";
import { SpectreError, type SpectreCRM } from "./crm.ts";
import { STAGES, OPEN_STAGES, type Stage } from "./model.ts";
import { normalizeTag } from "./contacts-plus.ts";
import { personalize, sendMessage, type Providers } from "./messaging.ts";
import type { GrowthEvent, Trigger, TriggerType, Workflow, WorkflowJob, WorkflowStep } from "./growth-model.ts";

export const MAX_DEPTH = 3;
const MAX_STEPS = 25;
const MAX_WAIT_MIN = 90 * 24 * 60;
const TRIGGERS: TriggerType[] = ["contact.created", "tag.added", "form.submitted", "appointment.booked", "deal.stage_changed"];

export interface AutomationEngine {
  crm: SpectreCRM;
  providers: Providers;
  /** Raise an event caused by a step (re-enters `dispatch` and any outside listener). */
  raise: (ws: string, event: GrowthEvent) => Promise<void>;
}

/* ---------------- Builder validation ---------------- */

function cleanStep(crm: SpectreCRM, raw: any, i: number): WorkflowStep {
  const n = `Step ${i + 1}`;
  const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
  switch (raw?.type) {
    case "add_tag":
    case "remove_tag": {
      const tag = normalizeTag(raw.tag);
      if (!tag) throw new SpectreError("invalid", `${n}: choose a tag`);
      return { type: raw.type, tag };
    }
    case "create_task": {
      const summary = text(raw.summary, 300);
      if (!summary) throw new SpectreError("invalid", `${n}: describe the task`);
      const dueInDays = Math.max(0, Math.min(365, Math.round(Number(raw.dueInDays ?? 1)) || 0));
      return { type: "create_task", summary, dueInDays };
    }
    case "move_deal": {
      if (!STAGES.includes(raw.stage) || raw.stage === "lost") throw new SpectreError("invalid", `${n}: choose a stage (automations can't mark deals lost)`);
      return { type: "move_deal", stage: raw.stage };
    }
    case "send_email": {
      const subject = text(raw.subject, 300);
      const body = text(raw.body, 10_000);
      if (!subject || !body) throw new SpectreError("invalid", `${n}: the email needs a subject and a message`);
      return { type: "send_email", subject, body };
    }
    case "send_sms": {
      const body = text(raw.body, 1600);
      if (!body) throw new SpectreError("invalid", `${n}: write the text message`);
      return { type: "send_sms", body };
    }
    case "wait": {
      const minutes = Math.round(Number(raw.minutes));
      if (!(minutes >= 1 && minutes <= MAX_WAIT_MIN)) throw new SpectreError("invalid", `${n}: wait between 1 minute and 90 days`);
      return { type: "wait", minutes };
    }
    case "note": {
      const t = text(raw.text, 2000);
      if (!t) throw new SpectreError("invalid", `${n}: write the note`);
      return { type: "note", text: t };
    }
    default:
      throw new SpectreError("invalid", `${n}: unknown step`);
  }
}

function cleanTrigger(crm: SpectreCRM, ws: string, raw: any): Trigger {
  if (!TRIGGERS.includes(raw?.type)) throw new SpectreError("invalid", "Choose what starts the automation");
  const t: Trigger = { type: raw.type };
  if (raw.type === "tag.added") {
    const tag = normalizeTag(raw.tag);
    if (!tag) throw new SpectreError("invalid", "Choose the tag that starts the automation");
    t.tag = tag;
  }
  if (raw.type === "form.submitted" && raw.formId) {
    const f = crm.store.forms.get(String(raw.formId));
    if (!f || f.workspace !== ws) throw new SpectreError("invalid", "That form doesn't exist");
    t.formId = f.id;
  }
  if (raw.type === "appointment.booked" && raw.calendarId) {
    const c = crm.store.calendars.get(String(raw.calendarId));
    if (!c || c.workspace !== ws) throw new SpectreError("invalid", "That calendar doesn't exist");
    t.calendarId = c.id;
  }
  if (raw.type === "deal.stage_changed" && raw.toStage) {
    if (!STAGES.includes(raw.toStage)) throw new SpectreError("invalid", "Unknown stage");
    t.toStage = raw.toStage;
  }
  return t;
}

export function cleanWorkflowInput(crm: SpectreCRM, ws: string, raw: Record<string, any>) {
  const name = String(raw.name ?? "").trim().slice(0, 100);
  if (!name) throw new SpectreError("invalid", "Give the automation a name");
  const trigger = cleanTrigger(crm, ws, raw.trigger);
  const rawSteps = Array.isArray(raw.steps) ? raw.steps : [];
  if (!rawSteps.length) throw new SpectreError("invalid", "Add at least one step");
  if (rawSteps.length > MAX_STEPS) throw new SpectreError("invalid", `Automations can have up to ${MAX_STEPS} steps`);
  const steps = rawSteps.map((s: unknown, i: number) => cleanStep(crm, s, i));
  if (trigger.type === "deal.stage_changed" && steps.some((s: WorkflowStep) => s.type === "move_deal")) {
    // Fine, but never back into the stage that started it: that would loop.
    if (trigger.toStage && steps.some((s: WorkflowStep) => s.type === "move_deal" && s.stage === trigger.toStage)) {
      throw new SpectreError("invalid", "A step moves the deal into the stage that starts this automation");
    }
  }
  return { name, trigger, steps, active: raw.active === undefined ? true : Boolean(raw.active) };
}

export async function createWorkflow(crm: SpectreCRM, ws: string, actor: string, raw: Record<string, any>) {
  const input = cleanWorkflowInput(crm, ws, raw);
  const t = crm.now().toISOString();
  const wf: Workflow = { id: `wf_${randomUUID()}`, workspace: ws, ...input, createdAt: t, updatedAt: t, stats: { started: 0, completed: 0, failed: 0 } };
  crm.store.workflows.set(wf.id, wf);
  await crm.record(actor, `workflow:${wf.id}`, { event: "created", trigger: wf.trigger.type, steps: wf.steps.map((s) => s.type) });
  return wf;
}

export function getWorkflow(crm: SpectreCRM, ws: string, id: string) {
  const wf = crm.store.workflows.get(id);
  if (!wf || wf.workspace !== ws) throw new SpectreError("not_found", "Automation not found");
  return wf;
}

export async function updateWorkflow(crm: SpectreCRM, ws: string, actor: string, id: string, raw: Record<string, any>) {
  const wf = getWorkflow(crm, ws, id);
  const input = cleanWorkflowInput(crm, ws, { name: wf.name, trigger: wf.trigger, steps: wf.steps, active: wf.active, ...raw });
  const next: Workflow = { ...wf, ...input, updatedAt: crm.now().toISOString() };
  crm.store.workflows.set(id, next);
  if (!next.active) cancelJobs(crm, id);
  await crm.record(actor, `workflow:${id}`, { event: "updated", active: next.active, trigger: next.trigger.type, steps: next.steps.map((s) => s.type) });
  return next;
}

export async function deleteWorkflow(crm: SpectreCRM, ws: string, actor: string, id: string) {
  getWorkflow(crm, ws, id);
  cancelJobs(crm, id);
  crm.store.workflows.delete(id);
  await crm.record(actor, `workflow:${id}`, { event: "deleted" });
}

function cancelJobs(crm: SpectreCRM, workflowId: string) {
  for (const j of crm.store.jobs.values()) if (j.workflowId === workflowId && j.status === "waiting") j.status = "cancelled";
}

/* ---------------- Matching and running ---------------- */

export function matches(trigger: Trigger, e: GrowthEvent) {
  if (trigger.type !== e.type) return false;
  if (e.type === "tag.added") return trigger.tag === e.tag;
  if (e.type === "form.submitted") return !trigger.formId || trigger.formId === e.formId;
  if (e.type === "appointment.booked") return !trigger.calendarId || trigger.calendarId === e.calendarId;
  if (e.type === "deal.stage_changed") return !trigger.toStage || trigger.toStage === e.toStage;
  return true;
}

/** Start every matching workflow for an event. Returns the jobs started. */
export async function dispatch(engine: AutomationEngine, ws: string, e: GrowthEvent): Promise<WorkflowJob[]> {
  const depth = e.depth ?? 0;
  if (depth >= MAX_DEPTH) return [];
  const { crm } = engine;
  const started: WorkflowJob[] = [];
  const contactId = "contactId" in e ? e.contactId : undefined;
  const dealId = e.type === "deal.stage_changed" ? e.dealId : undefined;
  for (const wf of crm.list("workflows", ws)) {
    if (!wf.active || !matches(wf.trigger, e)) continue;
    const busy = [...crm.store.jobs.values()].some((j) => j.workflowId === wf.id && j.status === "waiting" && j.contactId === contactId && j.dealId === dealId);
    if (busy) continue;
    const job: WorkflowJob = {
      id: `jb_${randomUUID()}`, workspace: ws, workflowId: wf.id, stepIndex: 0, runAt: crm.now().toISOString(),
      contactId, dealId, depth, status: "waiting", log: [], createdAt: crm.now().toISOString(),
    };
    crm.store.jobs.set(job.id, job);
    wf.stats.started++;
    started.push(job);
    await runJob(engine, job);
  }
  return started;
}

/** Resume waiting jobs whose time has come, optionally for one workspace. */
export async function runDue(engine: AutomationEngine, ws?: string, limit = 200) {
  const now = engine.crm.now().toISOString();
  const due = [...engine.crm.store.jobs.values()]
    .filter((j) => j.status === "waiting" && j.runAt <= now && (!ws || j.workspace === ws))
    .sort((a, b) => a.runAt.localeCompare(b.runAt))
    .slice(0, limit);
  for (const j of due) await runJob(engine, j);
  return due.length;
}

async function runJob(engine: AutomationEngine, job: WorkflowJob) {
  const { crm } = engine;
  const wf = crm.store.workflows.get(job.workflowId);
  const log = (step: string, result: string) => { job.log.push({ at: crm.now().toISOString(), step, result }); if (job.log.length > 100) job.log.shift(); };
  if (!wf || !wf.active) {
    job.status = "cancelled";
    log("—", "Automation was turned off or deleted");
    return;
  }
  const depth = (job.depth ?? 0) + 1;
  while (job.stepIndex < wf.steps.length) {
    const step = wf.steps[job.stepIndex];
    if (step.type === "wait") {
      const resumeAt = new Date(crm.now().getTime() + step.minutes * 60_000).toISOString();
      // First time here: schedule. Resumed by runDue (last log is this wait): move on.
      if (job.log.at(-1)?.step !== `wait:${job.stepIndex}`) {
        job.runAt = resumeAt;
        job.status = "waiting";
        log(`wait:${job.stepIndex}`, `Waiting until ${resumeAt}`);
        return;
      }
      job.stepIndex++;
      continue;
    }
    try {
      log(step.type, await runStep(engine, wf, job, step, depth));
    } catch (err) {
      job.status = "failed";
      wf.stats.failed++;
      log(step.type, `Failed: ${(err as Error).message}`);
      await crm.record(`automation:${wf.id}`, `workflow:${wf.id}`, { event: "job.failed", job: job.id, step: step.type });
      return;
    }
    job.stepIndex++;
  }
  job.status = "done";
  wf.stats.completed++;
  await crm.record(`automation:${wf.id}`, `workflow:${wf.id}`, { event: "job.completed", job: job.id, steps: wf.steps.length });
}

async function runStep(engine: AutomationEngine, wf: Workflow, job: WorkflowJob, step: WorkflowStep, depth: number): Promise<string> {
  const { crm } = engine;
  const ws = job.workspace;
  const actor = `automation:${wf.id}`;
  const contact = job.contactId ? crm.store.contacts.get(job.contactId) : job.dealId ? firstContact(crm, ws, job.dealId) : undefined;
  const needContact = () => {
    if (!contact) throw new Error("No contact for this step");
    return contact;
  };
  const dealId = job.dealId ?? (contact ? latestOpenDeal(crm, ws, contact.id) : undefined);
  const company = contact?.companyId ? crm.store.companies.get(contact.companyId)?.name : undefined;

  switch (step.type) {
    case "add_tag": {
      const c = needContact();
      if (c.optedOut) return "Skipped: contact opted out";
      if (c.tags?.includes(step.tag)) return `Already tagged ${step.tag}`;
      await crm.updateContact(ws, actor, c.id, { tags: [...(c.tags ?? []), step.tag].sort() });
      await engine.raise(ws, { type: "tag.added", contactId: c.id, tag: step.tag, depth });
      return `Tagged ${step.tag}`;
    }
    case "remove_tag": {
      const c = needContact();
      if (!c.tags?.includes(step.tag)) return `Wasn't tagged ${step.tag}`;
      await crm.updateContact(ws, actor, c.id, { tags: c.tags.filter((t) => t !== step.tag) });
      return `Removed ${step.tag}`;
    }
    case "create_task": {
      const due = new Date(crm.now().getTime() + (step.dueInDays ?? 1) * 86_400_000).toISOString();
      const summary = contact ? personalize(step.summary, contact, company) : step.summary;
      await crm.logActivity(ws, actor, { kind: "task", summary, dueAt: due, done: false, contactIds: contact && !contact.optedOut ? [contact.id] : [], dealId, companyId: contact?.companyId });
      return `Task created, due ${due.slice(0, 10)}`;
    }
    case "note": {
      const text = contact ? personalize(step.text, contact, company) : step.text;
      await crm.logActivity(ws, actor, { kind: "note", summary: text, contactIds: contact && !contact.optedOut ? [contact.id] : [], dealId, companyId: contact?.companyId });
      return "Note added";
    }
    case "move_deal": {
      if (!dealId) return "Skipped: no open deal";
      const d = crm.deal(ws, dealId);
      if (d.stage === step.stage) return `Already in ${step.stage}`;
      await crm.moveDeal(ws, actor, dealId, step.stage as Stage);
      await engine.raise(ws, { type: "deal.stage_changed", dealId, toStage: step.stage, depth });
      return `Moved deal to ${step.stage}`;
    }
    case "send_email":
    case "send_sms": {
      const c = needContact();
      if (c.optedOut) return "Skipped: contact opted out";
      const channel = step.type === "send_email" ? "email" : "sms";
      if (channel === "email" && !c.email) return "Skipped: no email address";
      if (channel === "sms" && !c.phone) return "Skipped: no phone number";
      const m = await sendMessage(crm, engine.providers, ws, actor, { contactId: c.id, channel, subject: step.type === "send_email" ? step.subject : undefined, body: step.body });
      if (m.status === "failed") throw new Error(m.error ?? "provider refused the message");
      return m.status === "sent" ? `${channel === "email" ? "Email" : "SMS"} sent` : `Saved as a draft (no ${channel === "email" ? "email" : "SMS"} provider connected)`;
    }
    case "wait":
      return "";
  }
}

function firstContact(crm: SpectreCRM, ws: string, dealId: string) {
  const d = crm.store.deals.get(dealId);
  if (!d || d.workspace !== ws) return undefined;
  return d.contactIds.map((id) => crm.store.contacts.get(id)).find((c) => c && !c.optedOut);
}

function latestOpenDeal(crm: SpectreCRM, ws: string, contactId: string) {
  return crm.list("deals", ws)
    .filter((d) => d.contactIds.includes(contactId) && OPEN_STAGES.includes(d.stage))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
}
