/**
 * Conversations: email through Resend and SMS through Twilio, each switched on by
 * server environment variables. With no provider connected, messages are kept as
 * drafts so nothing is silently lost. Opted-out contacts are never messaged.
 * Message bodies stay in the workspace store; only the event goes on the ledger.
 */
import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import { SpectreError, type SpectreCRM } from "./crm.ts";
import type { Contact } from "./model.ts";
import type { Message } from "./growth-model.ts";

export interface OutgoingMessage {
  channel: "email" | "sms";
  to: string;
  subject?: string;
  body: string;
}

export interface MessageProvider {
  name: string;
  channel: "email" | "sms";
  send(msg: OutgoingMessage): Promise<{ providerId: string }>;
}

export interface Providers {
  email?: MessageProvider;
  sms?: MessageProvider;
}

type Fetch = typeof fetch;

export function resendProvider(opts: { apiKey: string; from: string; fetchImpl?: Fetch }): MessageProvider {
  const f = opts.fetchImpl ?? fetch;
  return {
    name: "resend",
    channel: "email",
    async send(m) {
      const res = await f("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ from: opts.from, to: [m.to], subject: m.subject ?? "", text: m.body }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok || !data.id) throw new Error(`Resend refused the email (${res.status}${data.message ? `: ${data.message}` : ""})`);
      return { providerId: data.id };
    },
  };
}

export function twilioProvider(opts: { accountSid: string; authToken: string; from: string; fetchImpl?: Fetch }): MessageProvider {
  const f = opts.fetchImpl ?? fetch;
  return {
    name: "twilio",
    channel: "sms",
    async send(m) {
      const res = await f(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(opts.accountSid)}/Messages.json`, {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString("base64")}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: m.to, From: opts.from, Body: m.body }).toString(),
      });
      const data = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
      if (!res.ok || !data.sid) throw new Error(`Twilio refused the SMS (${res.status}${data.message ? `: ${data.message}` : ""})`);
      return { providerId: data.sid };
    },
  };
}

/** Providers from the environment: RESEND_API_KEY + MAIL_FROM, TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM. */
export function providersFromEnv(env: Record<string, string | undefined> = process.env): Providers {
  const p: Providers = {};
  if (env.RESEND_API_KEY && env.MAIL_FROM) p.email = resendProvider({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM });
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) {
    p.sms = twilioProvider({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM });
  }
  return p;
}

/** Fill {{first_name}}, {{name}}, {{company}}, {{email}} and {{field.key}} from the contact. */
export function personalize(text: string, contact: Contact, companyName?: string) {
  const first = contact.name.trim().split(/\s+/)[0] ?? "";
  return text.replace(/\{\{\s*([a-z_.]+)\s*\}\}/gi, (_, key: string) => {
    const k = key.toLowerCase();
    if (k === "first_name") return first;
    if (k === "name") return contact.name;
    if (k === "company") return companyName ?? "";
    if (k === "email") return contact.email ?? "";
    if (k.startsWith("field.")) return contact.fields?.[k.slice(6)] ?? "";
    return "";
  });
}

export function normalizePhone(s: string) {
  const t = s.trim();
  const d = t.replace(/[^\d]/g, "");
  return d.length >= 7 && d.length <= 15 ? (t.startsWith("+") ? `+${d}` : d) : "";
}

const MAX_BODY = 10_000;

/** Send (or draft) a message to a contact and log it in the timeline. */
export async function sendMessage(
  crm: SpectreCRM,
  providers: Providers,
  ws: string,
  actor: string,
  input: { contactId: string; channel: "email" | "sms"; subject?: string; body: string },
): Promise<Message> {
  const contact = crm.contact(ws, input.contactId);
  if (contact.optedOut) throw new SpectreError("opted_out", "This contact opted out; they can't be messaged");
  if (input.channel !== "email" && input.channel !== "sms") throw new SpectreError("invalid", "Channel must be email or sms");
  const companyName = contact.companyId ? crm.list("companies", ws).find((c) => c.id === contact.companyId)?.name : undefined;
  const body = personalize(String(input.body ?? ""), contact, companyName).trim().slice(0, MAX_BODY);
  const subject = input.channel === "email" ? personalize(String(input.subject ?? ""), contact, companyName).trim().slice(0, 300) : undefined;
  if (!body) throw new SpectreError("invalid", "Write a message first");
  if (input.channel === "email" && !subject) throw new SpectreError("invalid", "Add a subject");
  const to = input.channel === "email" ? contact.email : contact.phone ? normalizePhone(contact.phone) : "";
  if (!to) throw new SpectreError("invalid", input.channel === "email" ? "This contact has no email address" : "This contact has no phone number");

  const msg: Message = {
    id: `ms_${randomUUID()}`, workspace: ws, contactId: contact.id, channel: input.channel, direction: "out",
    subject, body, status: "draft", at: crm.now().toISOString(), by: actor, read: true,
  };
  const provider = providers[input.channel];
  if (provider) {
    try {
      msg.providerId = (await provider.send({ channel: input.channel, to, subject, body })).providerId;
      msg.status = "sent";
      msg.provider = provider.name;
    } catch (e) {
      msg.status = "failed";
      msg.provider = provider.name;
      msg.error = (e as Error).message.slice(0, 300);
    }
  }
  crm.store.messages.set(msg.id, msg);
  await crm.record(actor, `message:${msg.id}`, { event: msg.status, channel: msg.channel, contact: contact.id, provider: msg.provider ?? null });
  if (msg.status === "sent") {
    await crm.logActivity(ws, actor, {
      kind: input.channel === "email" ? "email" : "note",
      summary: input.channel === "email" ? `Email: ${subject}` : `SMS: ${body.slice(0, 120)}`,
      contactIds: [contact.id],
      companyId: contact.companyId,
    });
  }
  return msg;
}

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);

/** An inbound SMS. Finds the contact by phone in every workspace that has them; STOP opts them out. */
export async function receiveSms(crm: SpectreCRM, from: string, body: string, providerId?: string) {
  const phone = normalizePhone(from);
  const digits = phone.replace(/\D/g, "");
  const tail = (s?: string) => (s ?? "").replace(/\D/g, "").slice(-10);
  const matches = digits ? [...crm.store.contacts.values()].filter((c) => !c.optedOut && c.phone && tail(c.phone) === digits.slice(-10)) : [];
  const stop = STOP_WORDS.has(body.trim().toLowerCase());
  const stored: Message[] = [];
  for (const c of matches) {
    const m: Message = {
      id: `ms_${randomUUID()}`, workspace: c.workspace, contactId: c.id, channel: "sms", direction: "in",
      body: body.slice(0, MAX_BODY), status: "received", provider: "twilio", providerId, at: crm.now().toISOString(), by: `contact:${c.id}`, read: false,
    };
    crm.store.messages.set(m.id, m);
    await crm.record("provider:twilio", `message:${m.id}`, { event: "received", channel: "sms", contact: c.id });
    if (stop) await crm.optOut(c.workspace, "provider:twilio", c.id);
  }
  return { matched: matches.length, optedOut: stop && matches.length > 0 };
}

/** Twilio webhook signature: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)). */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined) {
  if (!signature) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", authToken).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Conversation threads for the inbox, newest first. */
export function threads(crm: SpectreCRM, ws: string) {
  const byContact = new Map<string, Message[]>();
  for (const m of crm.list("messages", ws)) {
    const arr = byContact.get(m.contactId) ?? [];
    arr.push(m);
    byContact.set(m.contactId, arr);
  }
  const contacts = new Map(crm.list("contacts", ws).map((c) => [c.id, c]));
  return [...byContact.entries()]
    .map(([contactId, msgs]) => {
      msgs.sort((a, b) => a.at.localeCompare(b.at));
      const last = msgs[msgs.length - 1];
      const c = contacts.get(contactId);
      return {
        contactId, name: c?.name ?? "Unknown", optedOut: !!c?.optedOut, hasEmail: !!c?.email, hasPhone: !!c?.phone,
        last: { channel: last.channel, direction: last.direction, status: last.status, at: last.at, preview: (last.subject ? `${last.subject} — ` : "") + last.body.slice(0, 140) },
        unread: msgs.filter((m) => m.direction === "in" && !m.read).length,
        count: msgs.length,
      };
    })
    .sort((a, b) => b.last.at.localeCompare(a.last.at));
}
