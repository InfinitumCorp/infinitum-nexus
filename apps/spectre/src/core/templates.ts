/**
 * Message templates ("snippets"): saved email and SMS texts with merge fields, ready to drop
 * into a conversation, a campaign or an automation. Text stays off the ledger.
 */
import { randomUUID } from "node:crypto";
import type { SpectreCRM } from "./crm.ts";
import { SpectreError } from "./crm.ts";

export interface MessageTemplate {
  id: string;
  workspace: string;
  name: string;
  channel: "email" | "sms";
  subject?: string;
  body: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export const TEMPLATE_LIMITS = { perWorkspace: 300, body: 5000 };

function clean(raw: Record<string, unknown>) {
  const name = String(raw.name ?? "").trim().slice(0, 80);
  if (!name) throw new SpectreError("invalid", "Name the template");
  const channel = raw.channel === "sms" ? "sms" : raw.channel === "email" || raw.channel === undefined ? "email" : null;
  if (!channel) throw new SpectreError("invalid", "Channel must be email or sms");
  const body = String(raw.body ?? "").trim().slice(0, TEMPLATE_LIMITS.body);
  if (!body) throw new SpectreError("invalid", "Write the message");
  const subject = channel === "email" ? String(raw.subject ?? "").trim().slice(0, 300) || undefined : undefined;
  return { name, channel, subject, body } as const;
}

export function listTemplates(crm: SpectreCRM, ws: string, channel?: string) {
  return crm.list("templates", ws).filter((t) => !channel || t.channel === channel).sort((a, b) => a.name.localeCompare(b.name));
}

export function getTemplate(crm: SpectreCRM, ws: string, id: string) {
  const t = crm.store.templates.get(id);
  if (!t || t.workspace !== ws) throw new SpectreError("not_found", "Template not found");
  return t;
}

export async function createTemplate(crm: SpectreCRM, ws: string, actor: string, raw: Record<string, unknown>) {
  if (crm.list("templates", ws).length >= TEMPLATE_LIMITS.perWorkspace) throw new SpectreError("invalid", `A workspace can keep ${TEMPLATE_LIMITS.perWorkspace} templates`);
  const at = crm.now().toISOString();
  const t: MessageTemplate = { id: `tp_${randomUUID()}`, workspace: ws, ...clean(raw), createdBy: actor, createdAt: at, updatedAt: at };
  crm.store.templates.set(t.id, t);
  await crm.record(actor, `template:${t.id}`, { event: "template.created", channel: t.channel });
  return t;
}

export async function updateTemplate(crm: SpectreCRM, ws: string, actor: string, id: string, raw: Record<string, unknown>) {
  const t = getTemplate(crm, ws, id);
  const next = clean({ ...t, ...raw });
  Object.assign(t, next, { updatedAt: crm.now().toISOString() });
  if (!next.subject) delete t.subject;
  await crm.record(actor, `template:${t.id}`, { event: "template.updated" });
  return t;
}

export async function deleteTemplate(crm: SpectreCRM, ws: string, actor: string, id: string) {
  const t = getTemplate(crm, ws, id);
  crm.store.templates.delete(t.id);
  await crm.record(actor, `template:${t.id}`, { event: "template.deleted" });
}
