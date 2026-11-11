import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { MAX_SNAPSHOT_FILE_BYTES } from "./limits.ts";
import { LabyrinthError } from "./model.ts";
import type { LabyrinthStorage, Organization } from "./model.ts";

/** The part of a Postgres client the adapter needs (node-postgres, PGlite and others fit). */
export interface SqlQueryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}
/** A connection that can run one serializable all-or-nothing transaction. */
export interface SqlDatabase extends SqlQueryable {
  transaction<T>(fn: (tx: SqlQueryable) => Promise<T>): Promise<T>;
}

/** Another writer committed first. Nothing was written; reload and retry. */
export class LabyrinthStorageConflict extends LabyrinthError {
  constructor() { super("conflict", "Labyrinth storage changed; reload before retrying (stale writer conflict)"); }
}

interface Row { org_id: string; revision: string | number; nonce?: Uint8Array; tag?: Uint8Array; ciphertext?: Uint8Array }
interface Committed { revision: number; digest: string; org: Organization }

const digest = (json: string) => createHash("sha256").update(json).digest("hex");
const aad = (orgId: string, revision: number) => Buffer.from(`LBRNTH:pg:1:${orgId}:${revision}`);

/**
 * Transactional durable Labyrinth storage on Postgres (Supabase), for hosts with several or
 * short-lived instances. Replaces the single-writer EncryptedFileStorage.
 *
 * Every organization is its own AES-256-GCM envelope under its own HKDF-derived key, as in the
 * file adapter. The additional data binds the org id AND the revision, so an old envelope cannot
 * be replayed into a newer row. Keys never reach the database.
 *
 * The Labyrinth SDK is synchronous, so this adapter is a unit of work:
 *   1. `await refresh()` reads every committed envelope that changed since the last refresh;
 *   2. the synchronous SDK calls `load()` / `save()` against that state (`save` only stages);
 *   3. `await flush()` writes the changed envelopes in ONE transaction, each with a
 *      compare-and-swap on its revision. If any row moved, nothing is written and
 *      `LabyrinthStorageConflict` is thrown; a failed flush keeps every previous revision.
 * A caller must not report success before `flush()` resolves, and must rebuild its in-memory
 * SDK state (refresh + new Labyrinth) after a failed flush. LabyrinthHost does both.
 */
export class PostgresStorage implements LabyrinthStorage {
  readonly #db: SqlDatabase;
  readonly #key: (orgId: string) => Uint8Array;
  #committed = new Map<string, Committed>();
  #pending: Organization[] | null = null;
  #ready = false;

  constructor(db: SqlDatabase, keyForOrg: (orgId: string) => Uint8Array) {
    this.#db = db;
    this.#key = keyForOrg;
  }

  #getKey(orgId: string) {
    const key = this.#key(orgId);
    if (key.byteLength !== 32) throw new Error("Labyrinth requires a 32-byte per-organization key");
    return key;
  }

  #open(row: Row): Committed {
    const revision = Number(row.revision);
    const nonce = Buffer.from(row.nonce!);
    const tag = Buffer.from(row.tag!);
    if (!Number.isSafeInteger(revision) || revision < 1 || nonce.length !== 12 || tag.length !== 16) throw new LabyrinthError("integrity", "Invalid encryption envelope");
    let json: string;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#getKey(row.org_id), nonce);
      decipher.setAAD(aad(row.org_id, revision));
      decipher.setAuthTag(tag);
      json = Buffer.concat([decipher.update(Buffer.from(row.ciphertext!)), decipher.final()]).toString("utf8");
    } catch {
      throw new LabyrinthError("integrity", "Labyrinth envelope failed authentication (wrong key or tampered row)");
    }
    const org = JSON.parse(json) as Organization;
    if (org.id !== row.org_id) throw new LabyrinthError("integrity", "Organization mismatch");
    return { revision, digest: digest(json), org };
  }

  #seal(orgId: string, revision: number, json: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#getKey(orgId), nonce);
    cipher.setAAD(aad(orgId, revision));
    const ciphertext = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
    return { nonce, tag: cipher.getAuthTag(), ciphertext };
  }

  /** Pull committed envelopes that changed elsewhere. Returns true when the state changed. */
  async refresh(): Promise<boolean> {
    this.#pending = null;
    const heads = (await this.#db.query<Row>("select org_id, revision from lbrnth.org_snapshots")).rows;
    const stale = heads.filter(h => this.#committed.get(h.org_id)?.revision !== Number(h.revision)).map(h => h.org_id);
    const gone = [...this.#committed.keys()].filter(id => !heads.some(h => h.org_id === id));
    if (gone.length) throw new LabyrinthError("integrity", "A Labyrinth organization envelope disappeared");
    const first = !this.#ready;
    this.#ready = true;
    if (!stale.length) return first;
    const rows = (await this.#db.query<Row>("select org_id, revision, nonce, tag, ciphertext from lbrnth.org_snapshots where org_id = any($1::text[])", [stale])).rows;
    let bytes = 0;
    const next = new Map(this.#committed);
    for (const row of rows) {
      bytes += row.ciphertext?.byteLength ?? 0;
      if (bytes > MAX_SNAPSHOT_FILE_BYTES) throw new LabyrinthError("capacity", "Labyrinth store exceeds capacity");
      next.set(row.org_id, this.#open(row));
    }
    this.#committed = next;
    return true;
  }

  load(): Organization[] {
    if (!this.#ready) throw new Error("PostgresStorage.refresh() must complete before load()");
    return structuredClone([...this.#committed.values()].map(c => c.org));
  }

  /** Stages the snapshot. It becomes durable only when flush() resolves. */
  save(orgs: Organization[]): void {
    if (!this.#ready) throw new Error("PostgresStorage.refresh() must complete before save()");
    const ids = new Set(orgs.map(o => o.id));
    if (ids.size !== orgs.length) throw new LabyrinthError("invalid", "Duplicate organization");
    for (const id of this.#committed.keys()) if (!ids.has(id)) throw new LabyrinthError("invalid", "Labyrinth never removes an organization");
    this.#pending = structuredClone(orgs);
  }

  /** Forget a staged snapshot (the request failed before it could be committed). */
  discard(): void { this.#pending = null; }

  /** True when a staged snapshot differs from what is committed. */
  get dirty(): boolean { return this.#pending !== null; }

  /**
   * Commit the staged snapshot and `alsoInTransaction` atomically. Only organizations whose
   * plaintext changed are written. On any error nothing is written and the stage is dropped.
   */
  async flush(alsoInTransaction?: (tx: SqlQueryable) => Promise<void>): Promise<void> {
    const pending = this.#pending;
    this.#pending = null;
    const changed: { id: string; json: string; expected: number | null }[] = [];
    let total = 0;
    for (const org of pending ?? []) {
      const json = JSON.stringify(org);
      total += Buffer.byteLength(json);
      if (total > MAX_SNAPSHOT_FILE_BYTES) throw new LabyrinthError("capacity", "Labyrinth store exceeds capacity");
      const current = this.#committed.get(org.id);
      if (current?.digest === digest(json)) continue;
      changed.push({ id: org.id, json, expected: current?.revision ?? null });
    }
    if (!changed.length && !alsoInTransaction) return;
    await this.#db.transaction(async tx => {
      for (const c of changed) {
        const revision = (c.expected ?? 0) + 1;
        const { nonce, tag, ciphertext } = this.#seal(c.id, revision, c.json);
        const rows = c.expected === null
          ? (await tx.query("insert into lbrnth.org_snapshots (org_id, revision, nonce, tag, ciphertext) values ($1, 1, $2, $3, $4) on conflict (org_id) do nothing returning revision", [c.id, nonce, tag, ciphertext])).rows
          : (await tx.query("update lbrnth.org_snapshots set revision = $2, nonce = $3, tag = $4, ciphertext = $5 where org_id = $1 and revision = $6 returning revision", [c.id, revision, nonce, tag, ciphertext, c.expected])).rows;
        if (rows.length !== 1) throw new LabyrinthStorageConflict();
      }
      await alsoInTransaction?.(tx);
    });
    for (const c of changed) {
      this.#committed.set(c.id, { revision: (c.expected ?? 0) + 1, digest: digest(c.json), org: JSON.parse(c.json) as Organization });
    }
  }
}
