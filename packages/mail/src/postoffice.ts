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
import { refuseReason, type InboundAuth } from "./auth-results.ts";
import type { Attachment, FolderId, MailMessage, MailPayment, Person } from "./model.ts";
import { MAIL_DOMAIN } from "@infinitum/cid";
import { isCumulus, parsePeople, tomorrowMorning, validEmail } from "./logic.ts";
import type { CumulusTunnel } from "./tunnel.ts";
import { MapMailRepository, type MailRepository } from "./repository.ts";
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
  /** Stored files to attach (name-only entries can't be sent and are left out). */
  attachments?: { id: string; name: string; type?: string; size: number }[];
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
  attachments: { id: string; name: string; type?: string; size: number }[];
}

export type OutboundResult = { ok: true; providerId?: string } | { ok: false; error: string; permanent: boolean };

/** Temporary failures are retried this many times, with growing gaps, before the sender is told. */
export const OUTBOUND_MAX_ATTEMPTS = 6;
/**
 * A job claimed but never finished after this long: the run stopped between taking it and recording
 * the result, so it may or may not have gone out. It is never sent again (no duplicates); the
 * sender is told delivery couldn't be confirmed instead.
 */
const OUTBOUND_CLAIM_TIMEOUT_MS = 10 * 60_000;

export class PostOfficeStore {
  mailboxes = new Map<string, StoredMailbox>();
  /** Address or alias (lowercase) -> CID. */
  addresses = new Map<string, string>();
  outbound = new Map<string, OutboundMail>();
}

/** Shared storage (Cumulus://Cloud StorageQuota implements this). */
export interface MailQuota {
  charge(cid: string, product: "mail", bytes: number): Promise<void> | void;
  release(cid: string, product: "mail", bytes: number): Promise<void> | void;
  canFit(cid: string, bytes: number): Promise<boolean> | boolean;
  usage(cid: string): Promise<{ label: string; pct: number; usedBytes: number; limitBytes: number }> | { label: string; pct: number; usedBytes: number; limitBytes: number };
}

/** FIRM Wallet (WalletAccounts implements this). */
export interface MailPayments {
  transfer(fromCid: string, toCid: string, asset: string, amount: string, memo: string): Promise<{ id: string; asset: string; amount: string; ledgerHash?: string }>;
}

export interface PostOfficeOptions {
  /** In-memory mail (snapshotted to disk or nexus_docs). Ignored when `repository` is given. */
  store?: PostOfficeStore;
  /** Where mailboxes, addresses and outbound jobs are kept. Defaults to a MapMailRepository over `store`. */
  repository?: MailRepository;
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
  attachments?: Attachment[];
  /** Sender authentication from the receiving edge (see auth-results.ts). Absent = not checked. */
  auth?: InboundAuth;
}

/** Longest inbound body kept (characters); the rest is cut. */
export const MAX_INBOUND_BODY = 512 * 1024;

export const messageBytes =(m: Pick<MailMessage, "subject" | "body">) =>
  Buffer.byteLength(m.subject, "utf8") + Buffer.byteLength(m.body, "utf8") + 512; // headers

/** Storage the files on a message take. */
export const attachmentBytes = (files?: Attachment[]) => (files ?? []).reduce((n, f) => n + (f.size > 0 ? f.size : 0), 0);

const RESERVED_LOCAL = new Set([
  ...Object.values(SYSTEM_SENDERS).map((s) => s.email.split("@")[0]),
  "admin", "root", "support", "abuse", "noreply", "no-reply", "infinitum", "odin",
]);

/**
 * One PostOffice call's view of storage: every mailbox and outbound job it touches is read once,
 * and the ones it changed are written back together when the call finishes.
 */
class MailUnit {
  readonly boxes = new Map<string, StoredMailbox | undefined>();
  readonly dirty = new Set<string>();
  readonly jobs = new Map<string, OutboundMail>();
  readonly dirtyJobs = new Set<string>();
}

export class PostOffice {
  readonly repository: MailRepository;
  private readonly quota?: MailQuota;
  private readonly payments?: MailPayments;
  private readonly clock: () => Date;
  readonly tunnel?: CumulusTunnel;

  constructor(opts: PostOfficeOptions = {}) {
    this.repository = opts.repository ?? new MapMailRepository(opts.store ?? new PostOfficeStore());
    this.quota = opts.quota;
    this.payments = opts.payments;
    this.tunnel = opts.tunnel;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** The in-memory store, when the repository is the in-memory one (snapshots and at-rest sealing). */
  get store(): PostOfficeStore {
    const store = (this.repository as { store?: PostOfficeStore }).store;
    if (!store) throw new Error("This PostOffice keeps mail in a database, not an in-memory store");
    return store;
  }

  private now() {
    return this.clock().toISOString();
  }

  private async unit<T>(fn: (u: MailUnit) => Promise<T> | T): Promise<T> {
    const u = new MailUnit();
    const result = await fn(u);
    for (const cid of u.dirty) {
      const box = u.boxes.get(cid);
      if (box) await this.repository.putMailbox(box);
    }
    for (const id of u.dirtyJobs) await this.repository.putOutbound(u.jobs.get(id)!);
    return result;
  }

  /** The mailbox, read once per call. Doesn't mark it changed. */
  private async peek(u: MailUnit, cid: string): Promise<StoredMailbox | undefined> {
    if (!u.boxes.has(cid)) u.boxes.set(cid, await this.repository.mailbox(cid));
    return u.boxes.get(cid);
  }

  private async read(u: MailUnit, cid: string): Promise<StoredMailbox> {
    const box = await this.peek(u, cid);
    if (!box) throw new MailError("no_mailbox", "This Cumulus://ID has no mailbox yet");
    return box;
  }

  /** The mailbox, to be changed: it is written back when the call finishes. */
  private async box(u: MailUnit, cid: string): Promise<StoredMailbox> {
    const box = await this.read(u, cid);
    u.dirty.add(cid);
    return box;
  }

  private async job(u: MailUnit, id: string): Promise<OutboundMail | undefined> {
    if (!u.jobs.has(id)) {
      const job = await this.repository.outbound(id);
      if (!job) return undefined;
      u.jobs.set(id, job);
    }
    u.dirtyJobs.add(id);
    return u.jobs.get(id);
  }

  /* ---------------- Accounts ---------------- */

  /** Create the mailbox for a CID. Idempotent: provisioning twice returns the same mailbox. */
  provision(input: { cid: string; address: string; name?: string }): Promise<StoredMailbox> {
    return this.unit(async (u) => {
      const existing = await this.peek(u, input.cid);
      if (existing) return existing;
      const address = input.address.trim().toLowerCase();
      if (!validEmail(address) || !isCumulus(address)) throw new MailError("invalid_address", `Mailboxes live on @${MAIL_DOMAIN}`);
      const owner = await this.repository.cidForAddress(address);
      if (owner && owner !== input.cid) throw new MailError("taken", "That address belongs to another Cumulus://ID");
      if (!(await this.repository.claimAddress(address, input.cid))) throw new MailError("taken", "That address belongs to another Cumulus://ID");
      const box: StoredMailbox = {
        cid: input.cid,
        owner: { name: input.name?.trim() || address.split("@")[0], email: address },
        createdAt: this.now(),
        messages: [],
        aliases: [],
        tasks: [],
        contacts: [],
      };
      u.boxes.set(input.cid, box);
      u.dirty.add(input.cid);
      this.tunnel?.ensure(input.cid); // keys are made for people, never by them
      return box;
    });
  }

  async has(cid: string): Promise<boolean> {
    if (this.repository.hasMailbox) return this.repository.hasMailbox(cid);
    return Boolean(await this.repository.mailbox(cid));
  }

  /** The CID behind a Cumulus address or alias, if any. */
  resolve(address: string): Promise<string | undefined> {
    return this.repository.cidForAddress(address.trim().toLowerCase());
  }

  async addressOf(cid: string): Promise<string> {
    return this.unit(async (u) => (await this.read(u, cid)).owner.email);
  }

  /** Run a Mailbox operation against a stored mailbox and keep the result. */
  private async edit<T>(u: MailUnit, cid: string, fn: (mail: Mailbox) => T): Promise<T> {
    const box = await this.box(u, cid);
    const mail = new Mailbox(box, box.owner);
    const result = fn(mail);
    Object.assign(box, mail.snapshot());
    return result;
  }

  async view(cid: string) {
    const box = await this.unit((u) => this.read(u, cid));
    return {
      me: { ...box.owner, cid },
      messages: box.messages,
      aliases: box.aliases,
      tasks: box.tasks,
      contacts: box.contacts,
      events: [],
      unread: unreadThreads(box),
    };
  }

  /** The storage meter for this mailbox's owner (shared with Cloud). */
  async quotaOf(cid: string): Promise<{ label: string; pct: number }> {
    const q = this.quota ? await this.quota.usage(cid) : { label: "", pct: 0 };
    return { label: q.label, pct: q.pct };
  }

  async unreadCount(cid: string): Promise<number> {
    if (this.repository.unreadThreads) return this.repository.unreadThreads(cid);
    const box = await this.repository.mailbox(cid);
    return box ? unreadThreads(box) : 0;
  }

  /* ---------------- Sending and delivery ---------------- */

  send(cid: string, input: PostOfficeSendInput): Promise<{ id: string; delivered: number; queued: number; bounced: string[]; payment?: MailPayment }> {
    return this.unit((u) => this.sendIn(u, cid, input));
  }

  private async sendIn(u: MailUnit, cid: string, input: PostOfficeSendInput): Promise<{ id: string; delivered: number; queued: number; bounced: string[]; payment?: MailPayment }> {
    const sender = await this.read(u, cid);
    const to = parsePeople(input.to);
    const cc = parsePeople(input.cc ?? "");
    if (to.length === 0 || to.some((p) => !validEmail(p.email))) throw new MailError("bad_address", "Add a real address in To.");
    if (cc.some((p) => !validEmail(p.email))) throw new MailError("bad_address", "Check the Cc addresses.");
    if (!input.subject.trim() && !input.body.trim()) throw new MailError("empty", "Write a subject or a message.");

    const size = messageBytes({ subject: input.subject, body: input.body }) + attachmentBytes(input.attachments);
    if (this.quota && !(await this.quota.canFit(cid, size))) {
      throw new MailError("quota_exceeded", "Your Cumulus storage is full. Free up space in Mail or Cloud to send.");
    }

    // Pay by mail: the money moves first, all-or-nothing, so a message never claims a payment that failed.
    let payment: MailPayment | undefined;
    let payee: string | undefined;
    if (input.payment) {
      if (!this.payments) throw new MailError("payments_off", "FIRM Wallet isn't connected to this mailbox");
      if (to.length !== 1 || cc.length > 0) throw new MailError("payment_recipient", "Send a payment to exactly one person in To.");
      payee = await this.resolve(to[0].email);
      if (!payee) throw new MailError("payment_recipient", "Payments go to Cumulus://Mail addresses. This address doesn't have a FIRM Wallet.");
      if (payee === cid) throw new MailError("payment_recipient", "You can't pay yourself.");
      const tx = await this.payments.transfer(cid, payee, input.payment.asset, input.payment.amount, input.subject.slice(0, 140));
      payment = { asset: tx.asset, amount: tx.amount, txId: tx.id, ledgerHash: tx.ledgerHash };
    }

    const id = `m-${randomUUID()}`;
    const at = this.now();
    const result = await this.edit(u, cid, (mail) => mail.send({ ...input, id, now: at }));
    if (!result.ok) throw new MailError("bad_address", result.error);
    const sent = sender.messages.find((m) => m.id === id)!;
    if (payment) {
      sent.payment = payment;
      sent.labels = [...new Set([...sent.labels, "Wallet"])];
    }
    await this.quota?.charge(cid, "mail", size);

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
        await this.quota?.charge(cid, "mail", size);
        delivered++;
        continue;
      }
      if (!isCumulus(address)) {
        external.push(address);
        continue;
      }
      const rcpt = await this.resolve(address);
      if (!rcpt || !(await this.peek(u, rcpt))) {
        bounced.push(address);
        continue;
      }
      if (this.quota && !(await this.quota.canFit(rcpt, size))) {
        bounced.push(address);
        continue;
      }
      await this.deliver(u, rcpt, { ...sent, ...this.throughTunnel(cid, rcpt, sent), id: `m-${randomUUID()}`, folder: "inbox", unread: rcpt !== cid, starred: false, payment });
      await this.quota?.charge(rcpt, "mail", size);
      delivered++;
    }

    if (external.length) {
      const outside = (people: Person[]) => [...new Set(people.map((p) => p.email.toLowerCase()).filter((a) => external.includes(a)))];
      const job: OutboundMail = {
        id: `out-${randomUUID()}`, fromCid: cid, from: sender.owner.email, fromName: sender.owner.name, to: external,
        toList: outside(to), ccList: outside(cc), subject: sent.subject, body: sent.body, messageId: id,
        attachments: (sent.attachments ?? []).filter((a): a is Attachment & { id: string } => Boolean(a.id)).map(({ id, name, type, size }) => ({ id, name, type, size })),
        queuedAt: at, status: "queued", attempts: 0,
      };
      u.jobs.set(job.id, job);
      u.dirtyJobs.add(job.id);
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
      await this.notifyIn(u, cid, "postmaster", {
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

  private async deliver(u: MailUnit, cid: string, message: MailMessage) {
    const box = await this.box(u, cid);
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
  notify(cid: string, sender: SystemSender, input: { subject: string; body: string; threadId?: string; payment?: MailPayment }): Promise<MailMessage | null> {
    return this.unit((u) => this.notifyIn(u, cid, sender, input));
  }

  private async notifyIn(u: MailUnit, cid: string, sender: SystemSender, input: { subject: string; body: string; threadId?: string; payment?: MailPayment }): Promise<MailMessage | null> {
    const box = await this.peek(u, cid);
    if (!box) return null;
    const from = SYSTEM_SENDERS[sender];
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
    await this.deliver(u, cid, message);
    return message;
  }

  /**
   * Mail arriving from outside Cumulus (Email Routing). Delivered to each Cumulus recipient's inbox;
   * returns who got it and which recipients don't exist (the caller rejects the message if nobody did).
   * Mail claiming a Cumulus sender is refused: Cumulus mail never arrives from outside.
   */
  receive(input: InboundMail): Promise<{ delivered: string[]; unknown: string[] }> {
    return this.unit(async (u) => {
      const sender = input.from.email.trim().toLowerCase();
      if (!validEmail(sender)) throw new MailError("bad_sender", "The sender address isn't valid.");
      if (isCumulus(sender)) throw new MailError("spoofed_sender", "Mail from a Cumulus address can't arrive from outside Cumulus.");
      const refused = refuseReason(input.auth);
      if (refused) throw new MailError("dmarc_fail", refused);
      const subject = input.subject.slice(0, 998);
      const body = input.body.slice(0, MAX_INBOUND_BODY);
      const size = messageBytes({ subject, body }) + attachmentBytes(input.attachments);
      const delivered: string[] = [];
      const unknown: string[] = [];
      const seen = new Set<string>();
      for (const rcpt of input.recipients) {
        const address = rcpt.trim().toLowerCase();
        if (seen.has(address)) continue;
        seen.add(address);
        const cid = isCumulus(address) ? await this.resolve(address) : undefined;
        const box = cid ? await this.peek(u, cid) : undefined;
        if (!cid || !box || (this.quota && !(await this.quota.canFit(cid, size)))) {
          unknown.push(address);
          continue;
        }
        const id = `m-${randomUUID()}`;
        await this.deliver(u, cid, {
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
          auth: input.auth ? { ...input.auth } : undefined,
        });
        await this.quota?.charge(cid, "mail", size);
        delivered.push(address);
      }
      return { delivered, unknown };
    });
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
  async outboundQueue(): Promise<OutboundMail[]> {
    return (await this.repository.openOutbound()).filter((m) => m.status === "queued");
  }

  markOutbound(id: string, status: "sent" | "failed"): Promise<void> {
    return this.unit(async (u) => {
      const job = await this.job(u, id);
      if (job) job.status = status;
    });
  }

  /**
   * Take up to `limit` jobs that are due for sending and mark them "sending", so a second sender
   * running at the same time skips them. Call inside one transaction, send outside it, then report
   * each outcome with finishOutbound() as soon as it's known. Every job is handed out at most once
   * per attempt: one left in "sending" is closed as unconfirmed, never re-sent. Jobs from before
   * outside sending existed carry no body and are closed with a notice instead.
   */
  claimOutbound(limit = 20): Promise<OutboundSend[]> {
    return this.unit(async (u) => {
      const now = this.clock().getTime();
      const claimed: OutboundSend[] = [];
      const due = await this.repository.dueOutbound(new Date(now).toISOString(), new Date(now - OUTBOUND_CLAIM_TIMEOUT_MS).toISOString(), limit);
      for (const found of due) {
        if (claimed.length >= limit) break;
        const job = (await this.job(u, found.id))!;
        if (job.status === "sending") {
          await this.unconfirmedOutbound(u, job);
          continue;
        }
        if (job.body === undefined) {
          await this.closeOutbound(u, job, "Sending to addresses outside Cumulus wasn't available yet when this was sent. Please send it again.");
          continue;
        }
        job.status = "sending";
        job.claimedAt = this.now();
        const to = job.toList?.length ? job.toList : job.to;
        const cc = job.toList?.length ? (job.ccList ?? []) : [];
        claimed.push({ id: job.id, from: { email: job.from, name: job.fromName }, to, cc, subject: job.subject, text: job.body, attachments: job.attachments ?? [] });
      }
      return claimed;
    });
  }

  /** Record how a claimed job went: sent, retry later, or (permanent or out of retries) not delivered. */
  finishOutbound(id: string, result: OutboundResult): Promise<void> {
    return this.unit(async (u) => {
      const job = await this.job(u, id);
      if (!job || job.status !== "sending") return;
      job.claimedAt = undefined;
      if (result.ok) {
        job.status = "sent";
        job.providerId = result.providerId;
        job.error = undefined;
        await this.updateHops(u, job, "outbound", "Sent to the recipient's mail server.");
        return;
      }
      job.attempts = (job.attempts ?? 0) + 1;
      job.error = result.error;
      if (result.permanent || job.attempts >= OUTBOUND_MAX_ATTEMPTS) {
        await this.closeOutbound(u, job, result.error);
        return;
      }
      job.status = "queued";
      // 1, 2, 4, 8, 16 minutes between tries.
      job.nextAttemptAt = new Date(this.clock().getTime() + 60_000 * 2 ** (job.attempts - 1)).toISOString();
      await this.updateHops(u, job, "outbound", "Delayed. Cumulus will keep trying.");
    });
  }

  private async closeOutbound(u: MailUnit, job: OutboundMail, reason: string) {
    job.status = "failed";
    job.error = reason;
    await this.updateHops(u, job, "bounced", `Not delivered. ${reason}`);
    const sent = job.messageId ? (await this.peek(u, job.fromCid))?.messages.find((m) => m.id === job.messageId) : undefined;
    await this.notifyIn(u, job.fromCid, "postmaster", {
      subject: `Not delivered: ${job.subject}`,
      body: `Your message to ${job.to.join(", ")} wasn't delivered.

${reason}`,
      threadId: sent?.threadId,
    });
  }

  private async unconfirmedOutbound(u: MailUnit, job: OutboundMail) {
    job.status = "failed";
    job.claimedAt = undefined;
    job.error = "unconfirmed";
    await this.updateHops(u, job, "outbound", "Delivery couldn't be confirmed. It may have arrived.");
    const sent = job.messageId ? (await this.peek(u, job.fromCid))?.messages.find((m) => m.id === job.messageId) : undefined;
    await this.notifyIn(u, job.fromCid, "postmaster", {
      subject: `Delivery not confirmed: ${job.subject}`,
      body: `Cumulus started sending your message to ${job.to.join(", ")} but couldn't confirm it was delivered. It may have arrived. To avoid sending it twice, Cumulus won't retry on its own. If the recipient didn't get it, send it again.`,
      threadId: sent?.threadId,
    });
  }

  /** Show the job's progress on the sender's copy in Sent. */
  private async updateHops(u: MailUnit, job: OutboundMail, status: "outbound" | "bounced", detail: string) {
    if (!job.messageId) return;
    if (!(await this.peek(u, job.fromCid))) return;
    const box = await this.box(u, job.fromCid);
    const targets = new Set(job.to);
    for (const m of box.messages) {
      if (m.id !== job.messageId && m.id !== `${job.messageId}-in`) continue;
      m.delivery = (m.delivery ?? []).map((hop) => (targets.has(hop.email.toLowerCase()) ? { ...hop, status, detail } : hop));
    }
  }

  /* ---------------- Mailbox actions (scoped to the signed-in CID) ---------------- */

  saveDraft(cid: string, input: Omit<SendInput, "id" | "now">) {
    return this.unit((u) => this.edit(u, cid, (mail) => mail.saveDraft({ ...input, now: this.now() })));
  }

  /* ---------------- Schedule send ---------------- */

  /** Save a message to go out on its own later. It waits in Scheduled (a draft with a send time). */
  schedule(cid: string, input: PostOfficeSendInput, sendAt: string): Promise<{ id: string; sendAt: string }> {
    return this.unit(async (u) => {
      if (input.payment) throw new MailError("scheduled_payment", "Payments go out right away. Send this one now.");
      const at = Date.parse(sendAt);
      const now = this.clock().getTime();
      if (!Number.isFinite(at) || at <= now) throw new MailError("bad_time", "Pick a time in the future.");
      if (at > now + 366 * 86_400_000) throw new MailError("bad_time", "Schedule up to a year ahead.");
      const to = parsePeople(input.to);
      const cc = parsePeople(input.cc ?? "");
      if (to.length === 0 || [...to, ...cc].some((p) => !validEmail(p.email))) throw new MailError("bad_address", "Add a real address in To.");
      if (!input.subject.trim() && !input.body.trim()) throw new MailError("empty", "Write a subject or a message.");
      const { id } = await this.edit(u, cid, (mail) => mail.saveDraft({ ...input, now: this.now() }));
      const draft = (await this.box(u, cid)).messages.find((m) => m.id === id)!;
      draft.sendAt = new Date(at).toISOString();
      return { id, sendAt: draft.sendAt };
    });
  }

  /** Cancel a scheduled send. The message stays in Drafts. */
  unschedule(cid: string, id: string): Promise<boolean> {
    return this.unit(async (u) => {
      const draft = (await this.box(u, cid)).messages.find((m) => m.id === id && m.folder === "drafts" && m.sendAt);
      if (!draft) return false;
      delete draft.sendAt;
      return true;
    });
  }

  /** Send this mailbox's scheduled messages that are due. A failure goes back to Drafts with a notice. */
  sendDue(cid: string): Promise<number> {
    return this.unit(async (u) => {
      const now = this.clock().getTime();
      const due = (await this.box(u, cid)).messages.filter((m) => m.folder === "drafts" && m.sendAt && Date.parse(m.sendAt) <= now);
      let sent = 0;
      for (const draft of due) {
        delete draft.sendAt;
        try {
          await this.sendIn(u, cid, {
            to: draft.to.map((p) => p.email).join(", "), cc: draft.cc.map((p) => p.email).join(", "),
            subject: draft.subject === "(no subject)" ? "" : draft.subject, body: draft.body,
            threadId: draft.threadId !== draft.id ? draft.threadId : undefined, draftId: draft.id, attachments: draft.attachments,
          });
          sent++;
        } catch (error) {
          await this.notifyIn(u, cid, "postmaster", { subject: "A scheduled message wasn't sent", body: `"${draft.subject}" couldn't go out: ${(error as Error).message} It's waiting in Drafts.` });
        }
      }
      return sent;
    });
  }

  /** Every mailbox's due scheduled mail. The app runs this on a timer. */
  async sendAllDue(): Promise<number> {
    let sent = 0;
    const now = this.clock().getTime();
    for (const cid of await this.repository.mailboxCids()) {
      const box = await this.repository.mailbox(cid);
      if (!box?.messages.some((m) => m.folder === "drafts" && m.sendAt && Date.parse(m.sendAt) <= now)) continue;
      sent += await this.sendDue(cid);
    }
    return sent;
  }

  markThreadRead(cid: string, threadId: string): Promise<void> {
    return this.unit((u) => this.edit(u, cid, (mail) => mail.markThreadRead(threadId)));
  }

  toggleStar(cid: string, id: string): Promise<void> {
    return this.unit((u) => this.edit(u, cid, (mail) => mail.toggleStar(id)));
  }

  move(cid: string, id: string, folder: FolderId): Promise<void> {
    return this.unit((u) => this.moveIn(u, cid, id, folder));
  }

  private async moveIn(u: MailUnit, cid: string, id: string, folder: FolderId) {
    if (!["inbox", "sent", "drafts", "archive", "trash"].includes(folder)) throw new MailError("bad_folder", "Unknown folder");
    await this.edit(u, cid, (mail) => mail.move(id, folder));
  }

  /** Delete forever (from trash). Frees the storage it used. */
  remove(cid: string, id: string): Promise<void> {
    return this.unit((u) => this.removeIn(u, cid, id));
  }

  private async removeIn(u: MailUnit, cid: string, id: string) {
    const message = (await this.read(u, cid)).messages.find((m) => m.id === id);
    if (!message) return;
    await this.edit(u, cid, (mail) => mail.remove(id));
    if (!message.system && message.folder !== "drafts") await this.quota?.release(cid, "mail", messageBytes(message));
  }

  emptyTrash(cid: string): Promise<number> {
    return this.unit(async (u) => {
      const trash = (await this.read(u, cid)).messages.filter((m) => m.folder === "trash");
      for (const m of trash) await this.removeIn(u, cid, m.id);
      return trash.length;
    });
  }

  addAlias(cid: string, alias: string): Promise<boolean> {
    return this.unit(async (u) => {
      const cleaned = alias.trim().toLowerCase();
      const local = cleaned.split("@")[0] ?? "";
      if (RESERVED_LOCAL.has(local)) return false;
      if (await this.repository.cidForAddress(cleaned)) return false; // aliases are unique across all of Cumulus
      const box = await this.read(u, cid);
      if (!new Mailbox(structuredClone(box), box.owner).addAlias(cleaned)) return false;
      if (!(await this.repository.claimAddress(cleaned, cid))) return false;
      return this.edit(u, cid, (mail) => mail.addAlias(cleaned));
    });
  }

  addTask(cid: string, task: { title: string; detail: string; messageId?: string }) {
    return this.unit((u) => this.edit(u, cid, (mail) => mail.addTask({ id: `t-${randomUUID()}`, done: false, ...task })));
  }

  toggleTask(cid: string, id: string): Promise<void> {
    return this.unit((u) => this.edit(u, cid, (mail) => mail.toggleTask(id)));
  }

  async addContact(cid: string, contact: { name: string; email: string }): Promise<boolean> {
    const email = contact.email.trim();
    if (!validEmail(email)) return false;
    return this.unit((u) => this.edit(u, cid, (mail) =>
      mail.addContact({
        id: `c-${randomUUID()}`,
        name: contact.name.trim() || email,
        email,
        org: isCumulus(email) ? "Cumulus://Mail" : "External",
        note: "Saved from a message.",
      }),
    ));
  }

  /* ---------------- Conversation actions (with undo) ---------------- */

  /**
   * Act on whole conversations, the way Gmail does: archive or trash every message of the thread that
   * is in the box you're looking at, mark it read or unread, star or unstar it. Returns what changed
   * so the caller can offer Undo.
   */
  actOnThreads(cid: string, threadIds: string[], action: ThreadAction, view: string = "inbox"): Promise<{ count: number; before: ThreadSnapshot[] }> {
    return this.unit(async (u) => {
      const box = await this.box(u, cid);
      const want = new Set(threadIds.slice(0, 500));
      const me = box.owner.email.toLowerCase();
      const before: ThreadSnapshot[] = [];
      const touched = new Set<string>();
      const remember = (m: MailMessage) => {
        before.push({ id: m.id, folder: m.folder, unread: m.unread, starred: m.starred, snoozeUntil: m.snoozeUntil });
        touched.add(m.threadId);
      };
      const inView = (m: MailMessage) => (view === "starred" ? m.starred && m.folder !== "trash" : m.folder === view);
      const messages = box.messages.filter((m) => want.has(m.threadId) && m.folder !== "drafts");
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
    });
  }

  /** Hide a conversation until `until` (ISO). It leaves the inbox and comes back on its own. */
  snooze(cid: string, id: string, until: string): Promise<boolean> {
    return this.unit(async (u) => {
      const at = Date.parse(until);
      if (!Number.isFinite(at)) return false;
      const messages = (await this.box(u, cid)).messages;
      const message = messages.find((item) => item.id === id);
      if (!message) return false;
      for (const item of messages) {
        if (item.threadId !== message.threadId || item.folder === "drafts" || item.folder === "trash") continue;
        item.snoozeUntil = new Date(at).toISOString();
        item.unread = false;
      }
      return true;
    });
  }

  /** Put messages back exactly as they were before an action. Only this mailbox's own messages. */
  restore(cid: string, before: ThreadSnapshot[]): Promise<number> {
    return this.unit(async (u) => {
      const box = await this.box(u, cid);
      let n = 0;
      for (const s of before) {
        const m = box.messages.find((x) => x.id === s.id);
        if (!m) continue;
        Object.assign(m, { folder: s.folder, unread: s.unread, starred: s.starred, snoozeUntil: s.snoozeUntil });
        n++;
      }
      return n;
    });
  }

  /* ---------------- SCALVS Clean ---------------- */

  /** This mailbox's Clean rules and history (defaults when it has none yet). Read-only. */
  async cleanState(cid: string): Promise<CleanState> {
    return cleanStateOf(await this.unit((u) => this.read(u, cid)));
  }

  /** The stored Clean state, created with the defaults if missing. Marks the mailbox changed. */
  private async cleanIn(u: MailUnit, cid: string): Promise<CleanState> {
    const box = await this.box(u, cid);
    box.clean = cleanStateOf(box);
    return box.clean;
  }

  setCleanRules(cid: string, patch: Partial<CleanRules>): Promise<CleanRules> {
    return this.unit((u) => this.setRulesIn(u, cid, patch));
  }

  private async setRulesIn(u: MailUnit, cid: string, patch: Partial<CleanRules>) {
    const state = await this.cleanIn(u, cid);
    state.rules = normalizeRules({ ...state.rules, ...patch });
    return state.rules;
  }

  /** What the rules would clean right now, without moving anything. */
  async previewClean(cid: string): Promise<CleanAction[]> {
    const box = await this.unit((u) => this.read(u, cid));
    return planSweep(box.messages, cleanStateOf(box).rules, this.clock());
  }

  /**
   * Carry out cleaning actions. Only this mailbox's own messages move, protected mail is skipped,
   * and "delete" only removes mail that is already in Trash.
   */
  applyClean(cid: string, actions: CleanAction[], by: CleanLogEntry["by"]): Promise<CleanLogEntry[]> {
    return this.unit((u) => this.applyCleanIn(u, cid, actions, by));
  }

  private async applyCleanIn(u: MailUnit, cid: string, actions: CleanAction[], by: CleanLogEntry["by"]): Promise<CleanLogEntry[]> {
    const state = await this.cleanIn(u, cid);
    const box = await this.box(u, cid);
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
        if (action.kind === "delete") await this.removeIn(u, cid, id);
        else await this.moveIn(u, cid, id, action.kind === "archive" ? "archive" : "trash");
      }
      const entry: CleanLogEntry = { id: `cl-${randomUUID()}`, at: this.now(), kind: action.kind, ids, reason: action.reason.slice(0, 200), by };
      entries.push(entry);
      state.log.unshift(entry);
    }
    state.log = state.log.slice(0, 50);
    return entries;
  }

  /** Run the rules now ("Clean now"), or on their own when `by` is "rules". */
  runClean(cid: string, by: "rules" | "you" = "you"): Promise<CleanLogEntry[]> {
    return this.unit((u) => this.runCleanIn(u, cid, by));
  }

  private async runCleanIn(u: MailUnit, cid: string, by: "rules" | "you") {
    const state = await this.cleanIn(u, cid);
    state.lastRun = this.now();
    const box = await this.read(u, cid);
    return this.applyCleanIn(u, cid, planSweep(box.messages, state.rules, this.clock()), by);
  }

  /** Automatic cleaning: runs when the mailbox is opened, at most once an hour, if the owner left it on. */
  autoClean(cid: string): Promise<CleanLogEntry[]> {
    return this.unit(async (u) => {
      const box = await this.peek(u, cid);
      if (!box) return [];
      const state = cleanStateOf(box);
      if (!state.rules.auto) return [];
      if (state.lastRun && this.clock().getTime() - Date.parse(state.lastRun) < 3_600_000) return [];
      return this.runCleanIn(u, cid, "rules");
    });
  }

  /** Put an archive or trash clean-up back in the inbox. Deleting forever can't be undone. */
  undoClean(cid: string, logId: string): Promise<number> {
    return this.unit(async (u) => {
      const state = await this.cleanIn(u, cid);
      const entry = state.log.find((e) => e.id === logId);
      if (!entry || entry.undone || entry.kind === "delete") return 0;
      const box = await this.box(u, cid);
      let restored = 0;
      for (const id of entry.ids) {
        const m = box.messages.find((x) => x.id === id);
        if (m && (m.folder === "archive" || m.folder === "trash")) {
          await this.moveIn(u, cid, id, "inbox");
          restored++;
        }
      }
      entry.undone = true;
      return restored;
    });
  }

  /** Send a sender's future mail to Archive, and archive what's already in the inbox from them. */
  muteSender(cid: string, email: string): Promise<CleanLogEntry[]> {
    return this.unit(async (u) => {
      const address = email.trim().toLowerCase();
      if (!validEmail(address)) throw new MailError("bad_address", "That isn't an email address.");
      if (Object.values(SYSTEM_SENDERS).some((s) => s.email === address)) throw new MailError("protected_sender", "Cumulus account mail can't be muted.");
      const rules = (await this.cleanIn(u, cid)).rules;
      await this.setRulesIn(u, cid, { muted: [...rules.muted, address] });
      const ids = (await this.read(u, cid)).messages.filter((m) => m.folder === "inbox" && m.from.email.toLowerCase() === address).map((m) => m.id);
      return this.applyCleanIn(u, cid, [{ kind: "archive", ids, reason: `Muted ${address}` }], "you");
    });
  }

  unmuteSender(cid: string, email: string): Promise<void> {
    return this.unit(async (u) => {
      const address = email.trim().toLowerCase();
      const rules = (await this.cleanIn(u, cid)).rules;
      await this.setRulesIn(u, cid, { muted: rules.muted.filter((m) => m !== address) });
    });
  }

  async message(cid: string, id: string): Promise<MailMessage | undefined> {
    return (await this.unit((u) => this.read(u, cid))).messages.find((m) => m.id === id);
  }
}

function unreadThreads(box: StoredMailbox) {
  return new Set(box.messages.filter((m) => m.unread && m.folder === "inbox").map((m) => m.threadId)).size;
}

/** The mailbox's Clean state with defaults filled in, without changing the mailbox. */
function cleanStateOf(box: StoredMailbox): CleanState {
  const clean = box.clean ?? { rules: { ...DEFAULT_CLEAN_RULES, muted: [] }, log: [] };
  return { ...clean, rules: normalizeRules(clean.rules) };
}

export function isReservedMailName(username: string) {
  return RESERVED_LOCAL.has(username.toLowerCase());
}
