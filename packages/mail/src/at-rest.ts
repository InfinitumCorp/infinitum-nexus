/**
 * Mailboxes encrypted at rest with the Cumulus Tunnel.
 *
 * On disk, each message keeps only the routing metadata in the clear (folder, sender and recipient
 * addresses, time, flags). The subject, body and attachments are sealed to the mailbox owner's own
 * tunnel key. They are opened when the server loads the store.
 */
import { createHash } from "node:crypto";
import type { MailMessage } from "./model.ts";
import type { PostOfficeStore, StoredMailbox } from "./postoffice.ts";
import { CumulusTunnel, type SealedEnvelope } from "./tunnel.ts";

type Content = Pick<MailMessage, "subject" | "body" | "attachments">;
export type StoredMessage = Omit<MailMessage, "subject" | "body" | "attachments"> & Partial<Content> & { sealed?: SealedEnvelope };

const contentOf = (m: MailMessage): Content => ({ subject: m.subject, body: m.body, attachments: m.attachments });
const digest = (c: Content) => createHash("sha256").update(JSON.stringify(c)).digest("base64");

/** Re-sealing every message on every save would be slow; reuse an envelope while its content is unchanged. */
const cache = new WeakMap<CumulusTunnel, Map<string, { hash: string; env: SealedEnvelope }>>();

/** A copy of one mailbox, ready to write, with message content sealed to its owner. */
export function sealMailbox(box: StoredMailbox, tunnel: CumulusTunnel, cid = box.cid): StoredMailbox {
  const memo = cache.get(tunnel) ?? new Map();
  cache.set(tunnel, memo);
  tunnel.ensure(cid);
  const messages = box.messages.map((m): StoredMessage => {
    const locked = (m as StoredMessage).sealed && m.locked;
    if (locked) {
      const { subject: _s, body: _b, attachments: _a, locked: _l, ...meta } = m;
      return meta; // couldn't be opened on load: keep the original envelope untouched
    }
    const content = contentOf(m);
    const hash = digest(content);
    // The key's fingerprint is part of it: after the account's keys change (another server's were
    // adopted), an envelope sealed to the old keys must not be reused.
    const key = `${cid}|${m.id}|${tunnel.fingerprint(cid)}`;
    let hit = memo.get(key);
    if (!hit || hit.hash !== hash) {
      hit = { hash, env: tunnel.seal(cid, [cid], content) };
      memo.set(key, hit);
    }
    const { subject: _s, body: _b, attachments: _a, sealed: _old, locked: _l, ...meta } = m as StoredMessage & { locked?: boolean };
    return { ...meta, sealed: hit.env };
  });
  return { ...box, messages: messages as MailMessage[] };
}

/** Open one mailbox's sealed messages in place after loading. Returns how many could not be opened. */
export function openMailbox(box: StoredMailbox, tunnel: CumulusTunnel, cid = box.cid): number {
  let locked = 0;
  for (const m of box.messages as (StoredMessage & { locked?: boolean })[]) {
    if (!m.sealed) continue;
    try {
      const { payload } = tunnel.open<Content>(cid, m.sealed);
      m.subject = payload.subject;
      m.body = payload.body;
      if (payload.attachments) m.attachments = payload.attachments;
      else delete m.attachments; // a message without files reads back without the field, as it was
      delete m.sealed;
      delete m.locked;
    } catch {
      m.subject = "Encrypted message";
      m.body = "This message is encrypted with a key this server doesn't have. Check the tunnel master key.";
      m.attachments = [];
      m.locked = true;
      locked++;
    }
  }
  return locked;
}

/** A copy of the post office store, ready to write, with message content sealed to each owner. */
export function sealMailStore(store: PostOfficeStore, tunnel: CumulusTunnel): PostOfficeStore {
  const out = { ...store, mailboxes: new Map() } as PostOfficeStore;
  for (const [cid, box] of store.mailboxes) out.mailboxes.set(cid, sealMailbox(box, tunnel, cid));
  return out;
}

/** Open sealed messages in place after loading. Returns how many could not be opened. */
export function openMailStore(store: PostOfficeStore, tunnel: CumulusTunnel): number {
  let locked = 0;
  for (const [cid, box] of store.mailboxes) locked += openMailbox(box, tunnel, cid);
  return locked;
}
