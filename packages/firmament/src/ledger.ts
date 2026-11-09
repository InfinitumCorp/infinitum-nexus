import { canonicalize, sha256Hex } from "./canonical.ts";
import { type Signer, verifySignature } from "./keys.ts";
import { merkleRoot } from "./merkle.ts";
import { type LedgerStore, MemoryStore } from "./store.ts";

/**
 * What Firmament records, per the site: identity, provenance, licensing, payments and audit.
 * "grant"/"revoke" carry CID permission changes ("Every grant is recorded on Firmament Network").
 */
export type RecordType =
  | "identity"
  | "grant"
  | "revoke"
  | "provenance"
  | "license"
  | "payment"
  | "audit"
  | "attestation";

export interface RecordInput {
  type: RecordType;
  /** Product writing the record, e.g. "cid", "scalvs", "spectre". */
  product: string;
  /** Who acted (a CID, an agent id, a service key). */
  actor: string;
  /** What the record is about (an account, a file, a deal, a dataset). */
  subject: string;
  payload: Record<string, unknown>;
}

export interface Entry extends RecordInput {
  seq: number;
  prevHash: string;
  timestamp: string;
  signer: string;
  hash: string;
  signature: string;
}

export interface VerifyResult {
  ok: boolean;
  length: number;
  /** First sequence number that failed, if any. */
  brokenAt?: number;
  reason?: string;
}

export const GENESIS = "0".repeat(64);

// Writers using the same store must read the head and append as one operation.
// Persistent backends shared across processes must additionally enforce this
// transaction in the database; this queue coordinates one JavaScript process.
const pendingWrites = new WeakMap<LedgerStore, Promise<void>>();

function entryBody(e: Omit<Entry, "hash" | "signature">) {
  const { seq, prevHash, timestamp, signer, type, product, actor, subject, payload } = e;
  return canonicalize({ seq, prevHash, timestamp, signer, type, product, actor, subject, payload });
}

export class Ledger {
  /** Public keys allowed to write. Empty set = any valid signature accepted (development only). */
  private readonly authorized: Set<string>;
  private readonly store: LedgerStore;
  private readonly clock: () => Date;

  constructor(
    store: LedgerStore = new MemoryStore(),
    options: { authorizedSigners?: string[]; clock?: () => Date } = {},
  ) {
    this.store = store;
    this.authorized = new Set(options.authorizedSigners ?? []);
    this.clock = options.clock ?? (() => new Date());
  }

  authorize(publicKey: string) {
    this.authorized.add(publicKey);
  }

  async append(input: RecordInput, signer: Signer): Promise<Entry> {
    const snapshot = structuredClone(input);
    const previous = pendingWrites.get(this.store) ?? Promise.resolve();
    const write = previous.then(() => this.appendEntry(snapshot, signer));
    const settled = write.then(() => {}, () => {});
    pendingWrites.set(this.store, settled);
    void settled.then(() => {
      if (pendingWrites.get(this.store) === settled) pendingWrites.delete(this.store);
    });
    return write;
  }

  private async appendEntry(input: RecordInput, signer: Signer): Promise<Entry> {
    if (this.authorized.size > 0 && !this.authorized.has(signer.publicKey)) {
      throw new Error("Firmament: signer is not authorized to write to this ledger");
    }
    const head = await this.store.last();
    const unsigned = {
      ...input,
      seq: head ? head.seq + 1 : 0,
      prevHash: head ? head.hash : GENESIS,
      timestamp: this.clock().toISOString(),
      signer: signer.publicKey,
    };
    const body = entryBody(unsigned);
    const hash = sha256Hex(body);
    const entry: Entry = { ...unsigned, hash, signature: signer.sign(hash) };
    await this.store.append(entry);
    return entry;
  }

  async entries(): Promise<Entry[]> {
    return this.store.all();
  }

  async query(filter: Partial<Pick<Entry, "type" | "product" | "actor" | "subject">>): Promise<Entry[]> {
    return (await this.store.all()).filter((e) =>
      (Object.keys(filter) as (keyof typeof filter)[]).every((k) => e[k] === filter[k]),
    );
  }

  /** Recompute every hash, link and signature. Any edit, deletion, reorder or forged entry is caught. */
  async verify(): Promise<VerifyResult> {
    const all = await this.store.all();
    let prev = GENESIS;
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      const fail = (reason: string): VerifyResult => ({ ok: false, length: all.length, brokenAt: i, reason });
      if (e.seq !== i) return fail("sequence gap or reorder");
      if (e.prevHash !== prev) return fail("chain link broken");
      const { hash, signature, ...rest } = e;
      if (sha256Hex(entryBody(rest)) !== hash) return fail("entry contents altered");
      if (!verifySignature(e.signer, hash, signature)) return fail("invalid signature");
      if (this.authorized.size > 0 && !this.authorized.has(e.signer)) return fail("unauthorized signer");
      prev = hash;
    }
    return { ok: true, length: all.length };
  }

  /** Merkle root of all entry hashes: the value anchored to a public chain (Base) for outside verification. */
  async root(): Promise<string> {
    return merkleRoot((await this.store.all()).map((e) => e.hash));
  }
}

