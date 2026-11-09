/**
 * SCALVS Clean: keeps a Cumulus://Mail inbox tidy.
 *
 * `classify` sorts every message into a kind (a person, a newsletter, a notification, a receipt,
 * a bounce). `planSweep` turns the owner's rules into actions. The rules are deliberately gentle:
 * automatic cleaning only archives or trashes, both of which can be undone, and deleting forever
 * happens only when the owner turns on "Empty trash after N days".
 *
 * Some mail is never touched automatically: starred messages, unread mail from people, anything
 * carrying a FIRM Wallet payment, security notices, drafts and sent mail.
 */
import type { MailMessage } from "./model.ts";

export type MailKind = "person" | "newsletter" | "notification" | "receipt" | "bounce";

export interface CleanRules {
  /** Run the rules on their own whenever the mailbox is opened (at most once an hour). */
  auto: boolean;
  /** Archive read newsletters older than this many days. null turns the rule off. */
  newslettersAfterDays: number | null;
  /** Archive read notifications (Cloud shares, sign-in notices you've seen) after N days. */
  notificationsAfterDays: number | null;
  /** Move delivery failures to Trash after N days. */
  bouncesAfterDays: number | null;
  /** Delete Trash forever after N days. Off by default: this one can't be undone. */
  emptyTrashAfterDays: number | null;
  /** Senders whose mail skips the inbox and goes straight to Archive. */
  muted: string[];
}

export const DEFAULT_CLEAN_RULES: CleanRules = {
  auto: true,
  newslettersAfterDays: 7,
  notificationsAfterDays: 14,
  bouncesAfterDays: 30,
  emptyTrashAfterDays: null,
  muted: [],
};

export interface CleanAction {
  kind: "archive" | "trash" | "delete";
  ids: string[];
  reason: string;
}

export interface CleanLogEntry {
  id: string;
  at: string;
  kind: CleanAction["kind"];
  ids: string[];
  reason: string;
  /** "rules" for automatic cleaning, "scalvs" for an approved SCALVS suggestion, "you" for Clean now. */
  by: "rules" | "scalvs" | "you";
  undone?: boolean;
}

export interface CleanState {
  rules: CleanRules;
  log: CleanLogEntry[];
  lastRun?: string;
}

const BULK_LOCAL = /^(no-?reply|do-?not-?reply|news(letter)?s?|marketing|updates?|hello|info|digest|notifications?|alerts?|team|mailer|promo(tions)?|offers?|deals?)([.+_-]|$)/i;
const DAY = 86_400_000;

/** What kind of mail this is. Product mail is labelled by its sender; everything else by signals in the message. */
export function classify(message: MailMessage): MailKind {
  if (message.system === "postmaster") return "bounce";
  if (message.system === "wallet" || message.system === "ledger" || message.payment) return "receipt";
  if (message.system) return "notification";
  const local = message.from.email.split("@")[0] ?? "";
  const text = `${message.subject}\n${message.body}`.toLowerCase();
  if (BULK_LOCAL.test(local) || /\bunsubscribe\b|view (this|it) in your browser|manage (your )?preferences/.test(text)) return "newsletter";
  if (message.labels.some((label) => /^(promotions?|newsletters?|updates?)$/i.test(label))) return "newsletter";
  return "person";
}

/** Mail that cleaning never moves on its own. */
export function isProtected(message: MailMessage): boolean {
  if (message.starred || message.payment) return true;
  if (message.system === "security") return true;
  if (message.folder === "drafts" || message.folder === "sent") return true;
  return classify(message) === "person" && message.unread;
}

const older = (message: MailMessage, days: number | null, now: number) => days !== null && now - Date.parse(message.at) >= days * DAY;

export function normalizeRules(input: Partial<CleanRules> | undefined): CleanRules {
  const days = (v: unknown, fallback: number | null) => {
    if (v === null) return null;
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 1 && n <= 3650 ? n : fallback;
  };
  const d = DEFAULT_CLEAN_RULES;
  const r = input ?? {};
  return {
    auto: typeof r.auto === "boolean" ? r.auto : d.auto,
    newslettersAfterDays: days(r.newslettersAfterDays, d.newslettersAfterDays),
    notificationsAfterDays: days(r.notificationsAfterDays, d.notificationsAfterDays),
    bouncesAfterDays: days(r.bouncesAfterDays, d.bouncesAfterDays),
    emptyTrashAfterDays: days(r.emptyTrashAfterDays, d.emptyTrashAfterDays),
    muted: [...new Set((Array.isArray(r.muted) ? r.muted : d.muted).map((s) => String(s).trim().toLowerCase()).filter((s) => s.includes("@")))].slice(0, 500),
  };
}

/** What the rules would do right now. Pure: nothing is moved here. */
export function planSweep(messages: MailMessage[], rules: CleanRules, now: Date): CleanAction[] {
  const t = now.getTime();
  const muted = new Set(rules.muted);
  const buckets = { muted: [] as string[], newsletter: [] as string[], notification: [] as string[], bounce: [] as string[], trash: [] as string[] };
  for (const m of messages) {
    if (m.folder === "trash") {
      if (older(m, rules.emptyTrashAfterDays, t) && !m.starred) buckets.trash.push(m.id);
      continue;
    }
    if (m.folder !== "inbox" || isProtected(m)) continue;
    const kind = classify(m);
    if (muted.has(m.from.email.toLowerCase())) buckets.muted.push(m.id);
    else if (kind === "newsletter" && !m.unread && older(m, rules.newslettersAfterDays, t)) buckets.newsletter.push(m.id);
    else if (kind === "notification" && !m.unread && older(m, rules.notificationsAfterDays, t)) buckets.notification.push(m.id);
    else if (kind === "bounce" && older(m, rules.bouncesAfterDays, t)) buckets.bounce.push(m.id);
  }
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const actions: CleanAction[] = [];
  if (buckets.muted.length) actions.push({ kind: "archive", ids: buckets.muted, reason: `${plural(buckets.muted.length, "message")} from muted senders` });
  if (buckets.newsletter.length) actions.push({ kind: "archive", ids: buckets.newsletter, reason: `${plural(buckets.newsletter.length, "read newsletter")} older than ${rules.newslettersAfterDays} days` });
  if (buckets.notification.length) actions.push({ kind: "archive", ids: buckets.notification, reason: `${plural(buckets.notification.length, "read notification")} older than ${rules.notificationsAfterDays} days` });
  if (buckets.bounce.length) actions.push({ kind: "trash", ids: buckets.bounce, reason: `${plural(buckets.bounce.length, "delivery failure")} older than ${rules.bouncesAfterDays} days` });
  if (buckets.trash.length) actions.push({ kind: "delete", ids: buckets.trash, reason: `${plural(buckets.trash.length, "message")} in Trash longer than ${rules.emptyTrashAfterDays} days` });
  return actions;
}

/** Inbox mail grouped by kind, for the Clean overview. */
export function inboxMix(messages: MailMessage[]): Record<MailKind, number> {
  const mix: Record<MailKind, number> = { person: 0, newsletter: 0, notification: 0, receipt: 0, bounce: 0 };
  for (const m of messages) if (m.folder === "inbox") mix[classify(m)]++;
  return mix;
}

/** Senders who mail in bulk, busiest first: the candidates for "Mute". */
export function bulkSenders(messages: MailMessage[], rules: CleanRules, limit = 8): { email: string; name: string; count: number }[] {
  const muted = new Set(rules.muted);
  const counts = new Map<string, { email: string; name: string; count: number }>();
  for (const m of messages) {
    if (m.folder === "sent" || m.folder === "drafts" || m.system || classify(m) !== "newsletter") continue;
    const email = m.from.email.toLowerCase();
    if (muted.has(email)) continue;
    const row = counts.get(email) ?? { email, name: m.from.name, count: 0 };
    row.count++;
    counts.set(email, row);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}
