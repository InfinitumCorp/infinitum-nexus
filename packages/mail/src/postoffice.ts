/**
 * Cumulus://Mail post office: one mailbox per Cumulus://ID, the way every Google account has Gmail.
 *
 * - `provision` gives a CID its address (username@cumuluscloud.app) when the account is created.
 * - Mail between Cumulus addresses is delivered directly into the recipient's mailbox.
 * - Mail to outside addresses is queued for the outbound relay.
 * - Products send account mail with `notify` (security notices, Cloud shares, wallet receipts).
 * - Messages count against the person's shared Cumulus storage (Mail + Cloud).
 * - A message can carry a FIRM Wallet payment to its Cumulus recipient.
 */
import { randomUUID } from "node:crypto";
import { Mailbox, type MailSnapshot, type SendInput } from "./mailbox.ts";
import type { FolderId, MailMessage, MailPayment, Person } from "./model.ts";
import { MAIL_DOMAIN } from "@infinitum/cid";
import { isCumulus, parsePeople, tomorrowMorning, validEmail } from "./logic.ts";
import type { CumulusTunnel } from "./tunnel.ts";
import { DEFAULT_CLEAN_RULES, isProtected, normalizeRules, planSweep, type CleanAction, type CleanLogEntry, type CleanRules, type CleanState } from "./clean.ts";

export { MAIL_DOMAIN };

/** Product senders allowed to write account mail. Addresses are reserved; no person can take them. */
export const SYSTEM_SENDERS = {
  welcome: { name: "Cumulus", email: `welcome@${MAIL_DOMAIN}`, label: "Cumulus" },
  security: { name: "Cumulus://ID Security", email: `security@${MAIL_DOMAIN}`, label: "CID" },
  cloud: { name: "Cumulus://Cloud", email: `cloud@${MAIL_DOMAIN}`, label: "Cloud" },
  wallet: { name: "FIRM Wallet", email: `wallet@${MAIL_DOMAIN}`, label: "Wallet" },
  ledger: { name: "Firmament Network", email: `ledger@${MAIL_DOMAIN}`, label: "Firmament" },
  postmaster: { name: "Mail Delivery", email: `postmaster@${MAIL_DOMAIN}`, label: "Delivery" },
} as const;
export type SystemSender = keyof typeof SYSTEM_SENDERS;

export class MailError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface StoredMailbox extends MailSnapshot {
  cid: string;
  owner: Person;
  createdAt: string;
  /** SCALVS Clean rules and history for this mailbox. */
  clean?: CleanState;
}

export type ThreadAction = "archive" | "trash" | "inbox" | "read" | "unread" | "star" | "unstar" | "snooze";
export const THREAD_ACTIONS: ThreadAction[] = ["archive", "trash", "inbox", "read", "unread", "star", "unstar", "snooze"];
export interface ThreadSnapshot { id: string; folder: FolderId; unread: boolean; starred: boolean; snoozeUntil?: string }

export interface OutboundMail {
  id: string;
  fromCid: string;
  from: string;
  to: string[];
  subject: string;
  queuedAt: string;
  status: "queued" | "sending" | "sent" | "failed";
  /** The sender's copy in Sent, whose delivery status is updated as the job progresses. */
  messageId?: string;
  fromName?: string;
  /** Outside addresses, as they appeared in To and Cc. */
  toList?: string[];
  ccList?: string[];
  body?: string;
  attempts?: number;
  /** Earliest time to try again after a temporary failure. */
  nextAttemptAt?: string;
  claimedAt?: string;
  providerId?: string;
  error?: string;
}

/** What a sender (Cloudflare Email Sending) needs to put one job on the wire. */
export interface OutboundSend {
  id: string;
  from: { email: string; name?: string };
  to: string[];
  cc: string[];
  subject: string;
  text: string;
}

export type OutboundResult = { ok: true; providerId?: string } | { ok: false; error: string; permanent: boolean };

/** Temporary failures are retried this many times, with growing gaps, before the sender is told. */
export const OUTBOUND_MAX_ATTEMPTS = 6;
/** A job claimed but never finished (the sender crashed) goes back in the queue after this long. */
const OUTBOUND_CLAIM_TIMEOUT_MS = 10 * 60_000;

export class PostOfficeStore {
  mailboxes = new Map<string, StoredMailbox>();
  /** Address or alias (lowercase) -> CID. */
  addresses = new Map<string, string>();
  outbound = new Map<string, OutboundMail>();
}

/** Shared storage (Cumulus://Cloud StorageQuota implements this). */
export interface MailQuota {
  charge(cid: string, product: "mail", bytes: number): void;
  release(cid: string, product: "mail", bytes: number): void;
  canFit(cid: string, bytes: number): boolean;
  usage(cid: string): { label: string; pct: number; usedBytes: number; limitBytes: number };
}

/** FIRM Wallet (WalletAccounts implements this). */
export interface MailPayments {
  transfer(fromCid: string, toCid: string, asset: string, amount: string, memo: string): Promise<{ id: string; asset: string; amount: string; ledgerHash?: string }>;
}

export interface PostOfficeOptions {
  store?: PostOfficeStore;
  quota?: MailQuota;
  payments?: MailPayments;
  clock?: () => Date;
  /** Seals mail between Cumulus accounts (and, with a master key, mailboxes at rest). */
  tunnel?: CumulusTunnel;
}

export interface PostOfficeSendInput extends Omit<SendInput, "id" | "now"> {
  payment?: { asset: string; amount: string };
}

/** A message from outside Cumulus, already parsed from MIME. `recipients` is the SMTP envelope. */
export interface InboundMail {
  from: Person;
  recipients: string[];
  to: Person[];
  cc: Person[];
  subject: string;
  body: string;
  at?: string;
  attachments?: { name: string; size: number }[];
}

/** Longest inbound body kept (characters); the rest is cut. */
export const MAX_INBOUND_BODY = 512 * 1024;

export const messageBytes =(m: Pick<MailMessage, "subject" | "body">) =>
  Buffer.byteLength(m.subject, "utf8") + Buffer.byteLength(m.body, "utf8") + 512; // headers

const RESERVED_LOCAL = new Set([
  ...Object.values(SYSTEM_SENDERS).map((s) => s.email.split("@")[0]),
  "admin", "root", "support", "abuse", "noreply", "no-reply", "infinitum", "odin",
]);

export class PostOffice {
  readonly store: PostOfficeStore;
  private readonly quota?: MailQuota;
  private readonly payments?: MailPayments;
  private readonly clock: () => Date;
  readonly tunnel?: CumulusTunnel;

  constructor(opts: PostOfficeOptions = {}) {
    this.store = opts.store ?? new PostOfficeStore();
    this.quota = opts.quota;
    this.payments = opts.payments;
    this.tunnel = opts.tunnel;
    this.clock = opts.clock ?? (() => new Date());
  }

  private now() {
    return this.clock().toISOString();
  }

  /* ---------------- Accounts ---------------- */

  /** Create the mailbox for a CID. Idempotent: provisioning twice returns the same mailbox. */
  provision(input: { cid: string; address: string; name?: string }): StoredMailbox {
    const existing = this.store.mailboxes.get(input.cid);
    if (existing) return existing;
    const address = input.address.trim().toLowerCase();
    if (!validEmail(address) || !isCumulus(address)) throw new MailError("invalid_address", `Mailboxes live on @${MAIL_DOMAIN}`);
    const owner = this.store.addresses.get(address);
    if (owner && owner !== input.cid) throw new MailError("taken", "That address belongs to another Cumulus://ID");
    const box: StoredMailbox = {
      cid: input.cid,
      owner: { name: input.name?.trim() || address.split("@")[0], email: address },
      createdAt: this.now(),
      messages: [],
      aliases: [],
      tasks: [],
      contacts: [],
    };
    this.store.mailboxes.set(input.cid, box);
    this.store.addresses.set(address, input.cid);
    this.tunnel?.ensure(input.cid); // keys are made for people, never by them
    return box;
  }

  has(cid: string) {
    return this.store.mailboxes.has(cid);
  }

  /** The CID behind a Cumulus address or alias, if any. */
  resolve(address: string): string | undefined {
    return this.store.addresses.get(address.trim().toLowerCase());
  }

  addressOf(cid: string): string {
    return this.box(cid).owner.email;
  }

  private box(cid: string): StoredMailbox {
    const box = this.store.mailboxes.get(cid);
    if (!box) throw new MailError("no_mailbox", "This Cumulus://ID has no mailbox yet");
    return box;
  }

  /** Run a Mailbox operation against a stored mailbox and write the result back. */
  private edit<T>(cid: string, fn: (mail: Mailbox) => T): T {
    const box = this.box(cid);
    const mail = new Mailbox(box, box.owner);
    const result = fn(mail);
    Object.assign(box, mail.snapshot());
    return result;
  }

  view(cid: string) {
    const box = this.box(cid);
    const quota = this.quota?.usage(cid) ?? { label: "", pct: 0, usedBytes: 0, limitBytes: 0 };
    return {
      me: { ...box.owner, cid },
      messages: box.messages,
      aliases: box.aliases,
      tasks: box.tasks,
      contacts: box.contacts,
      events: [],
      quota: { label: quota.label, pct: quota.pct },
      unread: new Set(box.messages.filter((m) => m.unread && m.folder === "inbox").map((m) => m.threadId)).size,
    };
  }

  unreadCount(cid: string): number {
    return this.has(cid) ? this.view(cid).unread : 0;
  }

  /* ---------------- Sending and delivery ---------------- */

  async send(cid: string, input: PostOfficeSendInput): Promise<{ id: string; delivered: number; queued: number; bounced: string[]; payment?: MailPayment }> {
    const sender = this.box(cid);
    const to = parsePeople(input.to);
    const cc = parsePeople(input.cc ?? "");
    if (to.length === 0 || to.some((p) => !validEmail(p.email))) throw new MailError("bad_address", "Add a real address in To.");
    if (cc.some((p) => !validEmail(p.email))) throw new MailError("bad_address", "Check the Cc addresses.");
    if (!input.subject.trim() && !input.body.trim()) throw new MailError("empty", "Write a subject or a message.");

    const size = messageBytes({ subject: input.subject, body: input.body });
    if (this.quota && !this.quota.canFit(cid, size)) {
      throw new MailError("quota_exceeded", "Your Cumulus storage is full. Free up space in Mail or Cloud to send.");
    }

    // Pay by mail: the money moves first, all-or-nothing, so a message never claims a payment that failed.
    let payment: MailPayment | undefined;
    let payee: string | undefined;
    if (input.payment) {
      if (!this.payments) throw new MailError("payments_off", "FIRM Wallet isn't connected to this mailbox");
      if (to.length !== 1 || cc.length > 0) throw new MailError("payment_recipient", "Send a payment to exactly one person in To.");
      payee = this.resolve(to[0].email);
      if (!payee) throw new MailError("payment_recipient", "Payments go to Cumulus://Mail addresses. This address doesn't have a FIRM Wallet.");
      if (payee === cid) throw new MailError("payment_recipient", "You can't pay yourself.");
      const tx = await this.payments.transfer(cid, payee, input.payment.asset, input.payment.amount, input.subject.slice(0, 140));
      payment = { asset: tx.asset, amount: tx.amount, txId: tx.id, ledgerHash: tx.ledgerHash };
    }

    const id = `m-${randomUUID()}`;
    const at = this.now();
    const result = this.edit(cid, (mail) => mail.send({ ...input, id, now: at }));
    if (!result.ok) throw new MailError("bad_address", result.error);
    const sent = sender.messages.find((m) => m.id === id)!;
    if (payment) {
      sent.payment = payment;
      sent.labels = [...new Set([...sent.labels, "Wallet"])];
    }
    this.quota?.charge(cid, "mail", size);

    let delivered = 0;
    const bounced: string[] = [];
    const external: string[] = [];
    const seen = new Set<string>();
    const isSelf = (address: string) => address === sender.owner.email.toLowerCase();
    for (const person of [...to, ...cc]) {
      const address = person.email.toLowerCase();
      if (seen.has(address)) continue;
      seen.add(address);
      if (isSelf(address)) {
        // Mailbox.send already put the sender's own copy in their inbox.
        this.quota?.charge(cid, "mail", size);
        delivered++;
        continue;
      }
      if (!isCumulus(address)) {
        external.push(address);
        continue;
      }
      const rcpt = this.resolve(address);
      if (!rcpt) {
        bounced.push(address);
        continue;
      }
      if (this.quota && !this.quota.canFit(rcpt, size)) {
        bounced.push(address);
        continue;
      }
      this.deliver(rcpt, { ...sent, ...this.throughTunnel(cid, rcpt, sent), id: `m-${randomUUID()}`, folder: "inbox", unread: rcpt !== cid, starred: false, payment });
      this.quota?.charge(rcpt, "mail", size);
      delivered++;
    }

    if (external.length) {
      const outside = (people: Person[]) => [...new Set(people.map((p) => p.email.toLowerCase()).filter((a) => external.includes(a)))];
      const job: OutboundMail = {
        id: `out-${randomUUID()}`, fromCid: cid, from: sender.owner.email, fromName: sender.owner.name, to: external,
        toList: outside(to), ccList: outside(cc), subject: sent.subject, body: sent.body, messageId: id,
        queuedAt: at, status: "queued", attempts: 0,
      };
      this.store.outbound.set(job.id, job);
    }
    if (bounced.length) {
      sent.delivery = (sent.delivery ?? []).map((hop) => bounced.includes(hop.email)
        ? { ...hop, status: "bounced", detail: "Not delivered. No such Cumulus address, or the mailbox is full." }
        : hop);
    }
    if (this.tunnel && delivered > 0 && external.length === 0 && bounced.length === 0) sent.tunnel = { verified: true, fingerprint: this.tunnel.fingerprint(cid) };
    const selfCopy = sender.messages.find((m) => m.id === `${id}-in`);
    if (selfCopy) Object.assign(selfCopy, { delivery: sent.delivery, payment: sent.payment, labels: sent.labels });
    for (const address of bounced) {
      this.notify(cid, "postmaster", {
        subject: `Not delivered: ${sent.subject}`,
        body: `Your message to ${address} wasn't delivered. That Cumulus://Mail address doesn't exist, or its mailbox is full.\n\nEveryone else on the message received it.`,
        threadId: sent.threadId,
      });
    }
    return { id, delivered, queued: external.length, bounced, payment };
  }

  /**
   * The recipient's copy of the subject, body and files comes only out of an envelope sealed to the
   * recipient and signed by the sender, so what lands is exactly what the sender's account sealed.
   */
  private throughTunnel(from: string, to: string, sent: MailMessage): Partial<MailMessage> {
    if (!this.tunnel) return {};
    this.tunnel.ensure(from);
    this.tunnel.ensure(to);
    const envelope = this.tunnel.seal(from, [to], { subject: sent.subject, body: sent.body, attachments: sent.attachments ?? [] });
    const opened = this.tunnel.open<{ subject: string; body: string; attachments: MailMessage["attachments"] }>(to, envelope);
    return { ...opened.payload, tunnel: { verified: opened.verified, fingerprint: this.tunnel.fingerprint(from) } };
  }

  /** Tunnel fingerprint for a CID, for showing next to its address. */
  fingerprint(cid: string): string {
    return this.tunnel?.fingerprint(cid) ?? "";
  }

  private deliver(cid: string, message: MailMessage) {
    const box = this.box(cid);
    // A muted sender's mail skips the inbox. Product mail is never muted.
    if (!message.system && box.clean?.rules.muted.includes(message.from.email.toLowerCase())) {
      message.folder = "archive";
      message.unread = false;
    }
    box.messages.unshift(message);
  }

  /**
   * Account mail from a Cumulus product: sign-in alerts, Cloud shares, wallet receipts.
   * It goes straight to the inbox, isn't counted against storage, and can't be spoofed by people
   * because system sender addresses are reserved.
   */
  notify(cid: string, sender: SystemSender, input: { subject: string; body: string; threadId?: string; payment?: MailPayment }): MailMessage | null {
    if (!this.has(cid)) return null;
    const from = SYSTEM_SENDERS[sender];
    const box = this.box(cid);
    const id = `m-${randomUUID()}`;
    const message: MailMessage = {
      id,
      threadId: input.threadId ?? id,
      folder: "inbox",
      from: { name: from.name, email: from.email },
      to: [{ ...box.owner }],
      cc: [],
      subject: input.subject,
      body: input.body,
      at: this.now(),
      unread: true,
      starred: false,
      labels: [from.label],
      system: sender,
      payment: input.payment,
    };
    this.deliver(cid, message);
    return message;
  }

  /**
   * Mail arriving from outside Cumulus (Email Routing). Delivered to each Cumulus recipient's inbox;
   * returns who got it and which recipients don't exist (the caller rejects the message if nobody did).
   * Mail claiming a Cumulus sender is refused: Cumulus mail never arrives from outside.
   */
  receive(input: InboundMail): { delivered: string[]; unknown: string[] } {
    const sender = input.from.email.trim().toLowerCase();
    if (!validEmail(sender)) throw new MailError("bad_sender", "The sender address isn't valid.");
    if (isCumulus(sender)) throw new MailError("spoofed_sender", "Mail from a Cumulus address can't arrive from outside Cumulus.");
    const subject = input.subject.slice(0, 998);
    const body = input.body.slice(0, MAX_INBOUND_BODY);
    const size = messageBytes({ subject, body });
    const delivered: string[] = [];
    const unknown: string[] = [];
    const seen = new Set<string>();
    for (const rcpt of input.recipients) {
      const address = rcpt.trim().toLowerCase();
      if (seen.has(address)) continue;
      seen.add(address);
      const cid = isCumulus(address) ? this.resolve(address) : undefined;
      if (!cid || (this.quota && !this.quota.canFit(cid, size))) {
        unknown.push(address);
        continue;
      }
      const box = this.box(cid);
      const id = `m-${randomUUID()}`;
      this.deliver(cid, {
        id,
        threadId: this.threadFor(box, sender, subject) ?? id,
        folder: "inbox",
        from: { name: input.from.name.trim() || sender, email: sender },
        to: input.to.length ? input.to : [{ ...box.owner }],
        cc: input.cc,
        subject,
        body,
        at: input.at ?? this.now(),
        unread: true,
        starred: false,
        labels: [],
        attachments: input.attachments?.length ? input.attachments : undefined,
      });
      this.quota?.charge(cid, "mail", size);
      delivered.push(address);
    }
    return { delivered, unknown };
  }

  /** A reply ("Re: x") from someone joins the thread of the earlier message "x" with that person. */
  private threadFor(box: StoredMailbox, sender: string, subject: string): string | undefined {
    const base = subject.replace(/^((re|fwd?|aw|wg)\s*:\s*)+/i, "").trim().toLowerCase();
    if (!base || base === subject.trim().toLowerCase()) return undefined;
    const match = box.messages.find((m) =>
      m.subject.replace(/^((re|fwd?|aw|wg)\s*:\s*)+/i, "").trim().toLowerCase() === base &&
      [m.from, ...m.to, ...m.cc].some((p) => p.email.toLowerCase() === sender));
    return match?.threadId;
  }

  /** Queued mail for the outbound relay (SMTP/JMAP bridge) to pick up. */
  outboundQueue(): OutboundMail[] {
    return [...this.store.outbound.values()].filter((m) => m.status === "queued");
  }

  markOutbound(id: string, status: "sent" | "failed") {
    const job = this.store.outbound.get(id);
    if (job) job.status = status;
  }

  /**
   * Take up to `limit` jobs that are due for sending and mark them "sending", so a second sender
   * running at the same time skips them. Call inside one transaction, send outside it, then report
   * each outcome with finishOutbound(). Jobs from before outside sending existed carry no body and
   * are closed with a notice instead.
   */
  claimOutbound(limit = 20): OutboundSend[] {
    const now = this.clock().getTime();
    const claimed: OutboundSend[] = [];
    for (const job of this.store.outbound.values()) {
      if (claimed.length >= limit) break;
      const stale = job.status === "sending" && Date.parse(job.claimedAt ?? "") < now - OUTBOUND_CLAIM_TIMEOUT_MS;
      if (job.status !== "queued" && !stale) continue;
      if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > now) continue;
      if (job.body === undefined) {
        this.closeOutbound(job, "Sending to addresses outside Cumulus wasn't available yet when this was sent. Please send it again.");
        continue;
      }
      job.status = "sending";
      job.claimedAt = this.now();
      const to = job.toList?.length ? job.toList : job.to;
      const cc = job.toList?.length ? (job.ccList ?? []) : [];
      claimed.push({ id: job.id, from: { email: job.from, name: job.fromName }, to, cc, subject: job.subject, text: job.body });
    }
    return claimed;
  }

  /** Record how a claimed job went: sent, retry later, or (permanent or out of retries) not delivered. */
  finishOutbound(id: string, result: OutboundResult) {
    const job = this.store.outbound.get(id);
    if (!job || job.status !== "sending") return;
    job.claimedAt = undefined;
    if (result.ok) {
      job.status = "sent";
      job.providerId = result.providerId;
      job.error = undefined;
      this.updateHops(job, "outbound", "Sent to the recipient's mail server.");
      return;
    }
    job.attempts = (job.attempts ?? 0) + 1;
    job.error = result.error;
    if (result.permanent || job.attempts >= OUTBOUND_MAX_ATTEMPTS) {
      this.closeOutbound(job, result.error);
      return;
    }
    job.status = "queued";
    // 1, 2, 4, 8, 16 minutes between tries.
    job.nextAttemptAt = new Date(this.clock().getTime() + 60_000 * 2 ** (job.attempts - 1)).toISOString();
    this.updateHops(job, "outbound", "Delayed. Cumulus will keep trying.");
  }

  private closeOutbound(job: OutboundMail, reason: string) {
    job.status = "failed";
    job.error = reason;
    this.updateHops(job, "bounced", `Not delivered. ${reason}`);
    const sent = job.messageId ? this.findMessage(job.fromCid, job.messageId) : undefined;
    this.notify(job.fromCid, "postmaster", {
      subject: `Not delivered: ${job.subject}`,
      body: `Your message to ${job.to.join(", ")} wasn't delivered.

${reason}`,
      threadId: sent?.threadId,
    });
  }

  private findMessage(cid: string, id: string): MailMessage | undefined {
    return this.store.mailboxes.get(cid)?.messages.find((m) => m.id === id);
  }

  /** Show the job's progress on the sender's copy in Sent. */
  private updateHops(job: OutboundMail, status: "outbound" | "bounced", detail: string) {
    if (!job.messageId) return;
    const box = this.store.mailboxes.get(job.fromCid);
    if (!box) return;
    const targets = new Set(job.to);
    for (const m of box.messages) {
      if (m.id !== job.messageId && m.id !== `${job.messageId}-in`) continue;
      m.delivery = (m.delivery ?? []).map((hop) => (targets.has(hop.email.toLowerCase()) ? { ...hop, status, detail } : hop));
    }
  }

  /* ---------------- Mailbox actions (scoped to the signed-in CID) ---------------- */

  saveDraft(cid: string, input: Omit<SendInput, "id" | "now">) {
    return this.edit(cid, (mail) => mail.saveDraft({ ...input, now: this.now() }));
  }

  /* ---------------- Schedule send ---------------- */

  /** Save a message to go out on its own later. It waits in Scheduled (a draft with a send time). */
  schedule(cid: string, input: PostOfficeSendInput, sendAt: string): { id: string; sendAt: string } {
    if (input.payment) throw new MailError("scheduled_payment", "Payments go out right away. Send this one now.");
    const at = Date.parse(sendAt);
    const now = this.clock().getTime();
    if (!Number.isFinite(at) || at <= now) throw new MailError("bad_time", "Pick a time in the future.");
    if (at > now + 366 * 86_400_000) throw new MailError("bad_time", "Schedule up to a year ahead.");
    const to = parsePeople(input.to);
    const cc = parsePeople(input.cc ?? "");
    if (to.length === 0 || [...to, ...cc].some((p) => !validEmail(p.email))) throw new MailError("bad_address", "Add a real address in To.");
    if (!input.subject.trim() && !input.body.trim()) throw new MailError("empty", "Write a subject or a message.");
    const { id } = this.saveDraft(cid, input);
    const draft = this.box(cid).messages.find((m) => m.id === id)!;
    draft.sendAt = new Date(at).toISOString();
    return { id, sendAt: draft.sendAt };
  }

  /** Cancel a scheduled send. The message stays in Drafts. */
  unschedule(cid: string, id: string): boolean {
    const draft = this.box(cid).messages.find((m) => m.id === id && m.folder === "drafts" && m.sendAt);
    if (!draft) return false;
    delete draft.sendAt;
    return true;
  }

  /** Send this mailbox's scheduled messages that are due. A failure goes back to Drafts with a notice. */
  async sendDue(cid: string): Promise<number> {
    const now = this.clock().getTime();
    const due = this.box(cid).messages.filter((m) => m.folder === "drafts" && m.sendAt && Date.parse(m.sendAt) <= now);
    let sent = 0;
    for (const draft of due) {
      delete draft.sendAt;
      try {
        await this.send(cid, {
          to: draft.to.map((p) => p.email).join(", "), cc: draft.cc.map((p) => p.email).join(", "),
          subject: draft.subject === "(no subject)" ? "" : draft.subject, body: draft.body,
          threadId: draft.threadId !== draft.id ? draft.threadId : undefined, draftId: draft.id, attachments: draft.attachments,
        });
        sent++;
      } catch (error) {
        this.notify(cid, "postmaster", { subject: "A scheduled message wasn't sent", body: `"${draft.subject}" couldn't go out: ${(error as Error).message} It's waiting in Drafts.` });
      }
    }
    return sent;
  }

  /** Every mailbox's due scheduled mail. The app runs this on a timer. */
  async sendAllDue(): Promise<number> {
    let sent = 0;
    for (const cid of this.store.mailboxes.keys()) sent += await this.sendDue(cid);
    return sent;
  }

  markThreadRead(cid: string, threadId: string) {
    this.edit(cid, (mail) => mail.markThreadRead(threadId));
  }

  toggleStar(cid: string, id: string) {
    this.edit(cid, (mail) => mail.toggleStar(id));
  }

  move(cid: string, id: string, folder: FolderId) {
    if (!["inbox", "sent", "drafts", "archive", "trash"].includes(folder)) throw new MailError("bad_folder", "Unknown folder");
    this.edit(cid, (mail) => mail.move(id, folder));
  }

  /** Delete forever (from trash). Frees the storage it used. */
  remove(cid: string, id: string) {
    const message = this.box(cid).messages.find((m) => m.id === id);
    if (!message) return;
    this.edit(cid, (mail) => mail.remove(id));
    if (!message.system && message.folder !== "drafts") this.quota?.release(cid, "mail", messageBytes(message));
  }

  emptyTrash(cid: string): number {
    const trash = this.box(cid).messages.filter((m) => m.folder === "trash");
    for (const m of trash) this.remove(cid, m.id);
    return trash.length;
  }

  addAlias(cid: string, alias: string): boolean {
    const cleaned = alias.trim().toLowerCase();
    const local = cleaned.split("@")[0] ?? "";
    if (RESERVED_LOCAL.has(local)) return false;
    if (this.store.addresses.has(cleaned)) return false; // aliases are unique across all of Cumulus
    const ok = this.edit(cid, (mail) => mail.addAlias(cleaned));
    if (ok) this.store.addresses.set(cleaned, cid);
    return ok;
  }

  addTask(cid: string, task: { title: string; detail: string; messageId?: string }) {
    return this.edit(cid, (mail) => mail.addTask({ id: `t-${randomUUID()}`, done: false, ...task }));
  }

  toggleTask(cid: string, id: string) {
    this.edit(cid, (mail) => mail.toggleTask(id));
  }

  addContact(cid: string, contact: { name: string; email: string }) {
    const email = contact.email.trim();
    if (!validEmail(email)) return false;
    return this.edit(cid, (mail) =>
      mail.addContact({
        id: `c-${randomUUID()}`,
        name: contact.name.trim() || email,
        email,
        org: isCumulus(email) ? "Cumulus://Mail" : "External",
        note: "Saved from a message.",
      }),
    );
  }

  /* ---------------- Conversation actions (with undo) ---------------- */

  /**
   * Act on whole conversations, the way Gmail does: archive or trash every message of the thread that
   * is in the box you're looking at, mark it read or unread, star or unstar it. Returns what changed
   * so the caller can offer Undo.
   */
  actOnThreads(cid: string, threadIds: string[], action: ThreadAction, box: string = "inbox"): { count: number; before: ThreadSnapshot[] } {
    const want = new Set(threadIds.slice(0, 500));
    const me = this.box(cid).owner.email.toLowerCase();
    const before: ThreadSnapshot[] = [];
    const touched = new Set<string>();
    const remember = (m: MailMessage) => {
      before.push({ id: m.id, folder: m.folder, unread: m.unread, starred: m.starred, snoozeUntil: m.snoozeUntil });
      touched.add(m.threadId);
    };
    const inView = (m: MailMessage) => (box === "starred" ? m.starred && m.folder !== "trash" : m.folder === box);
    const messages = this.box(cid).messages.filter((m) => want.has(m.threadId) && m.folder !== "drafts");
    for (const thread of want) {
      const all = messages.filter((m) => m.threadId === thread);
      if (!all.length) continue;
      const shown = all.filter(inView);
      if (action === "archive") for (const m of shown.filter((x) => x.folder === "inbox")) { remember(m); m.folder = "archive"; m.unread = false; }
      else if (action === "trash") for (const m of all.filter((x) => x.folder !== "trash")) { remember(m); m.folder = "trash"; m.unread = false; }
      else if (action === "inbox") for (const m of shown.filter((x) => x.folder === "archive" || x.folder === "trash")) {
        remember(m);
        m.folder = m.from.email.toLowerCase() === me && !m.system ? "sent" : "inbox";
      }
      else if (action === "read") for (const m of all.filter((x) => x.unread)) { remember(m); m.unread = false; }
      else if (action === "unread") {
        const received = all.filter((x) => x.from.email.toLowerCase() !== me && x.folder !== "trash").sort((a, b) => (a.at < b.at ? 1 : -1))[0];
        if (received && !received.unread) { remember(received); received.unread = true; }
      }
      else if (action === "star" || action === "unstar") {
        const latest = [...(shown.length ? shown : all)].sort((a, b) => (a.at < b.at ? 1 : -1))[0]!;
        if (action === "star" && !all.some((x) => x.starred)) { remember(latest); latest.starred = true; }
        if (action === "unstar") for (const m of all.filter((x) => x.starred)) { remember(m); m.starred = false; }
      }
      else if (action === "snooze") {
        const until = tomorrowMorning(this.clock());
        for (const m of all.filter((x) => x.folder !== "trash")) { remember(m); m.snoozeUntil = until; m.unread = false; }
      }
    }
    return { count: touched.size, before };
  }

  /** Hide a conversation until `until` (ISO). It leaves the inbox and comes back on its own. */
  snooze(cid: string, id: string, until: string) {
    const at = Date.parse(until);
    if (!Number.isFinite(at)) return false;
    const messages = this.box(cid).messages;
    const message = messages.find((item) => item.id === id);
    if (!message) return false;
    for (const item of messages) {
      if (item.threadId !== message.threadId || item.folder === "drafts" || item.folder === "trash") continue;
      item.snoozeUntil = new Date(at).toISOString();
      item.unread = false;
    }
    return true;
  }

  /** Put messages back exactly as they were before an action. Only this mailbox's own messages. */
  restore(cid: string, before: ThreadSnapshot[]): number {
    const box = this.box(cid);
    let n = 0;
    for (const s of before) {
      const m = box.messages.find((x) => x.id === s.id);
      if (!m) continue;
      Object.assign(m, { folder: s.folder, unread: s.unread, starred: s.starred, snoozeUntil: s.snoozeUntil });
      n++;
    }
    return n;
  }

  /* ---------------- SCALVS Clean ---------------- */

  cleanState(cid: string): CleanState {
    const box = this.box(cid);
    box.clean ??= { rules: { ...DEFAULT_CLEAN_RULES, muted: [] }, log: [] };
    box.clean.rules = normalizeRules(box.clean.rules);
    return box.clean;
  }

  setCleanRules(cid: string, patch: Partial<CleanRules>): CleanRules {
    const state = this.cleanState(cid);
    state.rules = normalizeRules({ ...state.rules, ...patch });
    return state.rules;
  }

  /** What the rules would clean right now, without moving anything. */
  previewClean(cid: string): CleanAction[] {
    return planSweep(this.box(cid).messages, this.cleanState(cid).rules, this.clock());
  }

  /**
   * Carry out cleaning actions. Only this mailbox's own messages move, protected mail is skipped,
   * and "delete" only removes mail that is already in Trash.
   */
  applyClean(cid: string, actions: CleanAction[], by: CleanLogEntry["by"]): CleanLogEntry[] {
    const state = this.cleanState(cid);
    const box = this.box(cid);
    const entries: CleanLogEntry[] = [];
    for (const action of actions) {
      const ids = [...new Set(action.ids)].filter((id) => {
        const m = box.messages.find((x) => x.id === id);
        if (!m) return false;
        if (action.kind === "delete") return m.folder === "trash" && !m.starred;
        return (m.folder === "inbox" || (action.kind === "trash" && m.folder === "archive")) && !isProtected(m);
      });
      if (!ids.length) continue;
      for (const id of ids) {
        if (action.kind === "delete") this.remove(cid, id);
        else this.move(cid, id, action.kind === "archive" ? "archive" : "trash");
      }
      const entry: CleanLogEntry = { id: `cl-${randomUUID()}`, at: this.now(), kind: action.kind, ids, reason: action.reason.slice(0, 200), by };
      entries.push(entry);
      state.log.unshift(entry);
    }
    state.log = state.log.slice(0, 50);
    return entries;
  }

  /** Run the rules now ("Clean now"), or on their own when `by` is "rules". */
  runClean(cid: string, by: "rules" | "you" = "you"): CleanLogEntry[] {
    const state = this.cleanState(cid);
    state.lastRun = this.now();
    return this.applyClean(cid, this.previewClean(cid), by);
  }

  /** Automatic cleaning: runs when the mailbox is opened, at most once an hour, if the owner left it on. */
  autoClean(cid: string): CleanLogEntry[] {
    if (!this.has(cid)) return [];
    const state = this.cleanState(cid);
    if (!state.rules.auto) return [];
    if (state.lastRun && this.clock().getTime() - Date.parse(state.lastRun) < 3_600_000) return [];
    return this.runClean(cid, "rules");
  }

  /** Put an archive or trash clean-up back in the inbox. Deleting forever can't be undone. */
  undoClean(cid: string, logId: string): number {
    const state = this.cleanState(cid);
    const entry = state.log.find((e) => e.id === logId);
    if (!entry || entry.undone || entry.kind === "delete") return 0;
    let restored = 0;
    for (const id of entry.ids) {
      const m = this.message(cid, id);
      if (m && (m.folder === "archive" || m.folder === "trash")) {
        this.move(cid, id, "inbox");
        restored++;
      }
    }
    entry.undone = true;
    return restored;
  }

  /** Send a sender's future mail to Archive, and archive what's already in the inbox from them. */
  muteSender(cid: string, email: string): CleanLogEntry[] {
    const address = email.trim().toLowerCase();
    if (!validEmail(address)) throw new MailError("bad_address", "That isn't an email address.");
    if (Object.values(SYSTEM_SENDERS).some((s) => s.email === address)) throw new MailError("protected_sender", "Cumulus account mail can't be muted.");
    const rules = this.cleanState(cid).rules;
    this.setCleanRules(cid, { muted: [...rules.muted, address] });
    const ids = this.box(cid).messages.filter((m) => m.folder === "inbox" && m.from.email.toLowerCase() === address).map((m) => m.id);
    return this.applyClean(cid, [{ kind: "archive", ids, reason: `Muted ${address}` }], "you");
  }

  unmuteSender(cid: string, email: string) {
    const address = email.trim().toLowerCase();
    this.setCleanRules(cid, { muted: this.cleanState(cid).rules.muted.filter((m) => m !== address) });
  }

  message(cid: string, id: string): MailMessage | undefined {
    return this.box(cid).messages.find((m) => m.id === id);
  }
}

export function isReservedMailName(username: string) {
  return RESERVED_LOCAL.has(username.toLowerCase());
}
