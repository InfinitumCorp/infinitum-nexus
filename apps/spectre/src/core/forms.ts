import { randomUUID } from "node:crypto";
import type { SpectreCRM } from "./crm.ts";
import { SpectreError } from "./crm.ts";
import type { Contact } from "./model.ts";
import type { Form, FormField, FormSubmission } from "./growth-model.ts";
import { normalizeFields, normalizeTags } from "./contacts-plus.ts";
import { normalizeCompanyName } from "./cleaning.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

export const digits = (phone: string) => phone.replace(/\D/g, "");

/** Validate a form definition from the builder. */
export function cleanFormInput(raw: Record<string, unknown>): Pick<Form, "name" | "headline" | "fields" | "tags" | "successMessage" | "active"> {
  const name = String(raw.name ?? "").trim().slice(0, 100);
  if (!name) throw new SpectreError("invalid", "Give the form a name");
  const rawFields = Array.isArray(raw.fields) ? raw.fields : [];
  if (!rawFields.length) throw new SpectreError("invalid", "Add at least one field");
  if (rawFields.length > 30) throw new SpectreError("invalid", "Forms can have up to 30 fields");
  const seen = new Set<string>();
  const fields: FormField[] = rawFields.map((f: any, i: number) => {
    const key = String(f.key ?? `field_${i + 1}`).trim().toLowerCase();
    if (!KEY.test(key) || seen.has(key)) throw new SpectreError("invalid", `Field ${i + 1} needs a unique key (letters, numbers, underscore)`);
    seen.add(key);
    const type = ["text", "email", "phone", "textarea", "select"].includes(f.type) ? f.type : "text";
    const label = String(f.label ?? "").trim().slice(0, 100) || key;
    const options = type === "select" ? (Array.isArray(f.options) ? f.options : String(f.options ?? "").split(",")).map((o: unknown) => String(o).trim().slice(0, 100)).filter(Boolean).slice(0, 50) : undefined;
    if (type === "select" && !options?.length) throw new SpectreError("invalid", `"${label}" needs options`);
    const map = String(f.map ?? "");
    const okMap = ["name", "email", "phone", "title", "company"].includes(map) || /^field:[a-z0-9_]{1,40}$/.test(map);
    return { key, label, type, required: Boolean(f.required), options, map: (okMap ? map : `field:${key}`) as FormField["map"] };
  });
  if (!fields.some((f) => f.map === "name")) throw new SpectreError("invalid", "One field must be the person's name");
  if (!fields.some((f) => f.map === "email" || f.map === "phone")) throw new SpectreError("invalid", "Ask for an email address or phone number so you can follow up");
  return {
    name,
    headline: String(raw.headline ?? "").trim().slice(0, 200) || undefined,
    fields,
    tags: normalizeTags(raw.tags),
    successMessage: String(raw.successMessage ?? "").trim().slice(0, 500) || "Thanks! We'll be in touch soon.",
    active: raw.active === undefined ? true : Boolean(raw.active),
  };
}

export async function createForm(crm: SpectreCRM, ws: string, actor: string, raw: Record<string, unknown>): Promise<Form> {
  const t = crm.now().toISOString();
  const form: Form = { id: `fm_${randomUUID()}`, workspace: ws, ...cleanFormInput(raw), createdAt: t, updatedAt: t };
  crm.store.forms.set(form.id, form);
  await crm.record(actor, `form:${form.id}`, { event: "form.created", fields: form.fields.length });
  return form;
}

export async function updateForm(crm: SpectreCRM, ws: string, actor: string, id: string, raw: Record<string, unknown>): Promise<Form> {
  const form = crm.store.forms.get(id);
  if (!form || form.workspace !== ws) throw new SpectreError("not_found", "Form not found");
  const next: Form = { ...form, ...cleanFormInput({ ...form, ...raw }), updatedAt: crm.now().toISOString() };
  crm.store.forms.set(id, next);
  await crm.record(actor, `form:${id}`, { event: "form.updated", active: next.active });
  return next;
}

/** Find an existing contact by email, then by phone (last 7+ digits must match exactly). */
export function findContact(crm: SpectreCRM, ws: string, email?: string, phone?: string): Contact | undefined {
  const contacts = crm.list("contacts", ws);
  if (email) {
    const hit = contacts.find((c) => c.email === email);
    if (hit) return hit;
  }
  const p = phone ? digits(phone) : "";
  if (p.length >= 7) return contacts.find((c) => c.phone && digits(c.phone) === p);
  return undefined;
}

async function companyByName(crm: SpectreCRM, ws: string, actor: string, name: string) {
  const n = normalizeCompanyName(name);
  return crm.list("companies", ws).find((c) => normalizeCompanyName(c.name) === n) ?? crm.addCompany(ws, actor, { name });
}

export interface SubmitResult {
  submission: FormSubmission;
  contact: Contact;
  created: boolean;
  addedTags: string[];
}

/**
 * Handle a public form submission: validate, find or create the contact, apply tags and fields,
 * log it on the contact's timeline and keep the raw answers.
 */
export async function submitForm(crm: SpectreCRM, form: Form, answers: Record<string, unknown>, meta: { referrer?: string } = {}): Promise<SubmitResult> {
  if (!form.active) throw new SpectreError("inactive", "This form isn't accepting responses right now");
  const ws = form.workspace;
  const actor = `form:${form.id}`;
  const clean: Record<string, string> = {};
  const errors: string[] = [];
  for (const f of form.fields) {
    const v = String(answers[f.key] ?? "").trim().slice(0, f.type === "textarea" ? 5000 : 300);
    if (!v) {
      if (f.required) errors.push(`${f.label} is required`);
      continue;
    }
    if (f.type === "email" && !EMAIL.test(v)) errors.push(`${f.label} doesn't look like an email address`);
    if (f.type === "phone" && digits(v).length < 7) errors.push(`${f.label} doesn't look like a phone number`);
    if (f.type === "select" && !f.options?.includes(v)) errors.push(`Choose a valid option for ${f.label}`);
    clean[f.key] = v;
  }
  if (errors.length) throw new SpectreError("invalid", errors.join(". "));

  const pick = (m: string) => form.fields.filter((f) => f.map === m).map((f) => clean[f.key]).find(Boolean);
  const name = pick("name");
  const email = pick("email")?.toLowerCase();
  const phone = pick("phone");
  if (!name) throw new SpectreError("invalid", "Please tell us your name");
  if (!email && !phone) throw new SpectreError("invalid", "Please leave an email address or phone number");

  const custom = normalizeFields(Object.fromEntries(form.fields.filter((f) => f.map.startsWith("field:")).map((f) => [f.map.slice(6), clean[f.key]])));
  const companyName = pick("company");
  const title = pick("title");

  let contact = findContact(crm, ws, email, phone);
  if (contact?.optedOut) {
    // Honor the opt-out: keep only the submission count, never re-add their details.
    throw new SpectreError("opted_out", "Thanks. This address has asked not to be contacted, so we didn't save it.");
  }
  const created = !contact;
  const before = new Set(contact?.tags ?? []);
  if (!contact) {
    const company = companyName ? await companyByName(crm, ws, actor, companyName) : undefined;
    contact = await crm.addContact(ws, actor, { name, email, phone, title, companyId: company?.id, tags: form.tags, fields: custom, source: `form:${form.id}` });
  } else {
    const company = companyName && !contact.companyId ? await companyByName(crm, ws, actor, companyName) : undefined;
    contact = await crm.updateContact(ws, actor, contact.id, {
      email: contact.email ?? email,
      phone: contact.phone ?? phone,
      title: contact.title ?? title,
      companyId: contact.companyId ?? company?.id,
      tags: normalizeTags([...(contact.tags ?? []), ...form.tags]),
      fields: { ...contact.fields, ...custom },
    });
  }

  const submission: FormSubmission = {
    id: `sub_${randomUUID()}`, workspace: ws, formId: form.id, contactId: contact.id, answers: clean, at: crm.now().toISOString(),
    referrer: meta.referrer?.slice(0, 300),
  };
  crm.store.submissions.set(submission.id, submission);
  await crm.logActivity(ws, actor, { kind: "note", summary: `Filled in "${form.name}"`, contactIds: [contact.id], companyId: contact.companyId, inbound: true });
  return { submission, contact, created, addedTags: (contact.tags ?? []).filter((t) => !before.has(t)) };
}
