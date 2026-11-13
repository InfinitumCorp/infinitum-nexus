/**
 * Cumulus://Mail storage boundary (relational storage plan, phase 5, Mail step 1). The PostOffice reads
 * and writes only through this interface: a mailbox, an address, an outbound job at a time, with every
 * change an explicit put, so a database (mail_mailboxes, mail_addresses, mail_outbound) can replace
 * the in-memory one. The mailbox is still the unit (all its messages together); per-message rows are
 * step 2.
 *
 * MapMailRepository keeps today's PostOfficeStore and its snapshot format (and at-rest sealing)
 * exactly as they are.
 */
import type { OutboundMail, PostOfficeStore, StoredMailbox } from "./postoffice.ts";

export interface MailRepository {
  mailbox(cid: string): Promise<StoredMailbox | undefined>;
  putMailbox(box: StoredMailbox): Promise<void>;
  /** Every CID with a mailbox (the scheduled-send timer walks them). */
  mailboxCids(): Promise<string[]>;
  /** Address or alias (lowercase) -> CID. */
  cidForAddress(address: string): Promise<string | undefined>;
  /** Claim an address for a CID. False when another CID already holds it (addresses are unique). */
  claimAddress(address: string, cid: string): Promise<boolean>;
  outbound(id: string): Promise<OutboundMail | undefined>;
  putOutbound(job: OutboundMail): Promise<void>;
  /** Jobs still to be handled ("queued" or "sending"), oldest first. */
  openOutbound(): Promise<OutboundMail[]>;
}

export class MapMailRepository implements MailRepository {
  readonly store: PostOfficeStore;
  constructor(store: PostOfficeStore) {
    this.store = store;
  }
  async mailbox(cid: string) {
    return this.store.mailboxes.get(cid);
  }
  async putMailbox(box: StoredMailbox) {
    this.store.mailboxes.set(box.cid, box);
  }
  async mailboxCids() {
    return [...this.store.mailboxes.keys()];
  }
  async cidForAddress(address: string) {
    return this.store.addresses.get(address.trim().toLowerCase());
  }
  async claimAddress(address: string, cid: string) {
    const key = address.trim().toLowerCase();
    const owner = this.store.addresses.get(key);
    if (owner && owner !== cid) return false;
    this.store.addresses.set(key, cid);
    return true;
  }
  async outbound(id: string) {
    return this.store.outbound.get(id);
  }
  async putOutbound(job: OutboundMail) {
    this.store.outbound.set(job.id, job);
  }
  async openOutbound() {
    return [...this.store.outbound.values()].filter((j) => j.status === "queued" || j.status === "sending");
  }
}

/** Test double that copies values in and out, as a database does, so nothing relies on shared objects. */
export class CopyingMailRepository implements MailRepository {
  readonly #inner: MapMailRepository;
  constructor(store: PostOfficeStore) {
    this.#inner = new MapMailRepository(store);
  }
  get store() {
    return this.#inner.store;
  }
  async mailbox(cid: string) { return structuredClone(await this.#inner.mailbox(cid)); }
  async putMailbox(box: StoredMailbox) { return this.#inner.putMailbox(structuredClone(box)); }
  async mailboxCids() { return this.#inner.mailboxCids(); }
  async cidForAddress(address: string) { return this.#inner.cidForAddress(address); }
  async claimAddress(address: string, cid: string) { return this.#inner.claimAddress(address, cid); }
  async outbound(id: string) { return structuredClone(await this.#inner.outbound(id)); }
  async putOutbound(job: OutboundMail) { return this.#inner.putOutbound(structuredClone(job)); }
  async openOutbound() { return structuredClone(await this.#inner.openOutbound()); }
}
