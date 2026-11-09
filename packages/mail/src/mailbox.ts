import { EVENTS, ME, SEED_CONTACTS, SEED_MESSAGES, SEED_TASKS } from "./model.ts";
import type { Attachment, ArchitectTask, Contact, FolderId, MailMessage, MailRule } from "./model.ts";
import { applyRules, audienceLabel, isCumulus, parsePeople, planDelivery, quota, validEmail, withSignature } from "./logic.ts";

export interface MailSnapshot {
  messages: MailMessage[];
  aliases: string[];
  tasks: ArchitectTask[];
  contacts: Contact[];
  signature?: string;
  rules?: MailRule[];
}

/** Whose mailbox this is. Defaults to the demo account. */
export interface MailOwner {
  name: string;
  email: string;
}

export interface SendInput {
  /** Message id to use; the post office passes a globally unique one. */
  id?: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
  threadId?: string;
  draftId?: string;
  now?: string;
  attachments?: Attachment[];
}

export class Mailbox {
  messages: MailMessage[];
  aliases: string[];
  tasks: ArchitectTask[];
  contacts: Contact[];
  readonly owner: MailOwner;
  signature: string;
  rules: MailRule[];

  constructor(seed: Partial<MailSnapshot> = {}, owner: MailOwner = ME) {
    this.owner = { name: owner.name, email: owner.email };
    this.messages = structuredClone(seed.messages ?? SEED_MESSAGES);
    this.aliases = structuredClone(seed.aliases ?? ["press@cumuluscloud.app"]);
    this.tasks = structuredClone(seed.tasks ?? SEED_TASKS);
    this.contacts = structuredClone(seed.contacts ?? SEED_CONTACTS);
    this.signature = seed.signature ?? `${this.owner.name}\n${this.owner.email}`;
    this.rules = structuredClone(seed.rules ?? []);
  }

  snapshot(): MailSnapshot {
    return {
      messages: this.messages,
      aliases: this.aliases,
      tasks: this.tasks,
      contacts: this.contacts,
      signature: this.signature,
      rules: this.rules,
    };
  }

  view() {
    return {
      me: { ...ME, ...this.owner },
      messages: this.messages,
      aliases: this.aliases,
      tasks: this.tasks,
      contacts: this.contacts,
      events: EVENTS,
      quota: quota(this.messages),
      signature: this.signature,
      rules: this.rules,
    };
  }

  markThreadRead(threadId: string) {
    for (const message of this.messages) {
      if (message.threadId === threadId) message.unread = false;
    }
  }

  toggleStar(id: string) {
    const message = this.messages.find((item) => item.id === id);
    if (message) message.starred = !message.starred;
  }

  move(id: string, folder: FolderId) {
    const message = this.messages.find((item) => item.id === id);
    if (!message) return;
    message.folder = folder;
    message.unread = false;
  }

  remove(id: string) {
    this.messages = this.messages.filter((item) => item.id !== id);
  }

  send(input: SendInput): { ok: true; id: string } | { ok: false; error: string } {
    const to = parsePeople(input.to);
    const cc = parsePeople(input.cc ?? "");
    if (to.length === 0 || to.some((person) => !validEmail(person.email))) {
      return { ok: false, error: "Add a real address in To." };
    }
    if (cc.some((person) => !validEmail(person.email))) {
      return { ok: false, error: "Check the Cc addresses." };
    }
    if (!input.subject.trim() && !input.body.trim()) {
      return { ok: false, error: "Write a subject or a message." };
    }
    const id = input.id ?? `m-${(input.now ?? Date.now().toString(36)).replace(/[^\w-]/g, "").slice(-12)}`;
    if (input.draftId) this.remove(input.draftId);
    const sent: MailMessage = {
      id,
      threadId: input.threadId ?? id,
      folder: "sent",
      from: { ...this.owner },
      to,
      cc,
      subject: input.subject.trim() || "(no subject)",
      body: withSignature(input.body, this.signature),
      at: input.now ?? new Date().toISOString(),
      unread: false,
      starred: false,
      labels: [audienceLabel([...to, ...cc])],
      attachments: input.attachments ?? [],
      delivery: planDelivery([...to, ...cc]),
    };
    this.messages.unshift(sent);
    if ([...to, ...cc].some((person) => person.email.toLowerCase() === this.owner.email.toLowerCase())) {
      this.messages.unshift(applyRules({ ...sent, id: `${id}-in`, folder: "inbox", unread: true }, this.rules));
    }
    return { ok: true, id };
  }

  saveDraft(input: SendInput): { id: string } {
    const id = input.draftId ?? `d-${Date.now().toString(36)}`;
    const message: MailMessage = {
      id,
      threadId: input.threadId ?? id,
      folder: "drafts",
      from: { ...this.owner },
      to: parsePeople(input.to),
      cc: parsePeople(input.cc ?? ""),
      subject: input.subject.trim() || "(no subject)",
      body: input.body,
      at: input.now ?? new Date().toISOString(),
      unread: false,
      starred: false,
      labels: [],
      attachments: input.attachments ?? [],
    };
    const index = this.messages.findIndex((item) => item.id === id);
    if (index >= 0) this.messages[index] = message;
    else this.messages.unshift(message);
    return { id };
  }

  snooze(id: string, until: string) {
    const message = this.messages.find((item) => item.id === id);
    if (message) {
      message.snoozeUntil = until;
      message.unread = false;
    }
  }

  setSignature(signature: string) {
    this.signature = signature;
  }

  addRule(rule: MailRule) {
    this.rules.push(rule);
  }

  removeRule(id: string) {
    this.rules = this.rules.filter((rule) => rule.id !== id);
  }

  addAlias(alias: string) {
    const cleaned = alias.trim().toLowerCase();
    if (!validEmail(cleaned) || !isCumulus(cleaned) || cleaned === this.owner.email) return false;
    if (this.aliases.includes(cleaned)) return false;
    this.aliases.push(cleaned);
    return true;
  }

  addTask(task: ArchitectTask) {
    if (task.messageId && this.tasks.some((item) => item.messageId === task.messageId)) return false;
    this.tasks.unshift(task);
    return true;
  }

  toggleTask(id: string) {
    const task = this.tasks.find((item) => item.id === id);
    if (task) task.done = !task.done;
  }

  addContact(contact: Contact) {
    if (this.contacts.some((item) => item.email === contact.email)) return false;
    this.contacts.push(contact);
    return true;
  }
}
