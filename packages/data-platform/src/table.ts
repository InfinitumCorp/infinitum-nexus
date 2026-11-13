// © Infinitum Corporation®. All rights reserved.
/**
 * A small snapshot table format modelled on Apache Iceberg: immutable data files, a metadata
 * file that lists snapshots, and atomic commits that swap the current snapshot. Data files
 * are NDJSON today; the format records `file_format` so Parquet files can be added later
 * without changing readers.
 *
 * Unlike a plain Iceberg delete, `deleteWhere` here is a purge: rows are rewritten out of
 * their data files and every older snapshot is expired, so deleted rows do not survive in
 * history. That is what deletion propagation needs.
 */
import { randomUUID } from "node:crypto";
import { isConditional, PreconditionFailed, type ObjectStore } from "./storage.ts";

export type Row = Record<string, unknown>;

export interface DataFile {
  path: string;
  rows: number;
  partition: string;
  file_format: "ndjson";
}

export interface Snapshot {
  snapshot_id: string;
  parent_id: string | null;
  committed_at: string;
  operation: "append" | "delete" | "overwrite";
  data_files: DataFile[];
  summary: Record<string, string | number>;
}

export interface TableMetadata {
  format_version: 1;
  table: string;
  schema_version: string;
  last_sequence: number;
  current_snapshot_id: string | null;
  snapshots: Snapshot[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class Table {
  readonly store: ObjectStore;
  readonly name: string;
  private readonly prefix: string;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(store: ObjectStore, name: string) {
    if (!/^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/.test(name)) throw new Error(`table name must be zone/name: ${name}`);
    this.store = store;
    this.name = name;
    this.prefix = `tables/${name}`;
  }

  /** Serializes commits inside this process. Cross-process writers need a CAS-capable store. */
  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const fn = async (): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await op();
        } catch (e) {
          if (!(e instanceof PreconditionFailed) || attempt >= 7) throw e;
          await new Promise((r) => setTimeout(r, 5 * 2 ** attempt * Math.random()));
        }
      }
    };
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Etag of the metadata last read inside the current commit (null = table did not exist). */
  private readEtag: string | null = null;

  async metadata(): Promise<TableMetadata> {
    return (await this.load()).meta;
  }

  /** Reads metadata for a commit and remembers its etag. Only call inside `exclusive`. */
  private async loadForCommit(): Promise<TableMetadata> {
    const { meta, etag } = await this.load();
    this.readEtag = etag;
    return meta;
  }

  private async load(): Promise<{ meta: TableMetadata; etag: string | null }> {
    const key = `${this.prefix}/metadata.json`;
    let etag: string | null = null;
    let bytes: Uint8Array | undefined;
    if (isConditional(this.store)) {
      const r = await this.store.getWithEtag(key);
      bytes = r?.bytes;
      etag = r?.etag ?? null;
    } else {
      bytes = await this.store.get(key);
    }
    if (!bytes) {
      return { meta: { format_version: 1, table: this.name, schema_version: "1.0", last_sequence: 0, current_snapshot_id: null, snapshots: [] }, etag };
    }
    return { meta: JSON.parse(dec.decode(bytes)) as TableMetadata, etag };
  }

  /**
   * Swaps in new metadata. On a conditional store the swap only succeeds if nobody else
   * committed since we read; otherwise PreconditionFailed and the operation is retried.
   */
  private async commit(meta: TableMetadata): Promise<void> {
    const key = `${this.prefix}/metadata.json`;
    const bytes = enc.encode(JSON.stringify(meta, null, 1));
    if (isConditional(this.store)) await this.store.putIf(key, bytes, this.readEtag);
    else await this.store.put(key, bytes);
  }

  private current(meta: TableMetadata): Snapshot | undefined {
    return meta.snapshots.find((s) => s.snapshot_id === meta.current_snapshot_id);
  }

  private async readFile(f: DataFile): Promise<Row[]> {
    const bytes = await this.store.get(f.path);
    if (!bytes) throw new Error(`missing data file ${f.path}`);
    return dec
      .decode(bytes)
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Row);
  }

  private async writeFile(partition: string, rows: Row[]): Promise<DataFile> {
    const path = `${this.prefix}/data/${partition}/${randomUUID()}.ndjson`;
    await this.store.put(path, enc.encode(rows.map((r) => JSON.stringify(r)).join("\n") + "\n"));
    return { path, rows: rows.length, partition, file_format: "ndjson" };
  }

  /** Appends rows grouped by partition (for example `product=cumulus-cloud/date=2026-11-12`). */
  append(rows: Row[], partitionOf: (row: Row) => string): Promise<Snapshot | null> {
    return this.exclusive(async () => {
      if (rows.length === 0) return null;
      const groups = new Map<string, Row[]>();
      for (const r of rows) {
        const p = partitionOf(r);
        if (!/^[a-z_]+=[A-Za-z0-9_.-]+(\/[a-z_]+=[A-Za-z0-9_.-]+)*$/.test(p)) throw new Error(`bad partition ${p}`);
        let g = groups.get(p);
        if (!g) groups.set(p, (g = []));
        g.push(r);
      }
      const meta = await this.loadForCommit();
      const parent = this.current(meta);
      const added: DataFile[] = [];
      for (const [p, g] of groups) added.push(await this.writeFile(p, g));
      const snap: Snapshot = {
        snapshot_id: randomUUID(),
        parent_id: parent?.snapshot_id ?? null,
        committed_at: new Date().toISOString(),
        operation: "append",
        data_files: [...(parent?.data_files ?? []), ...added],
        summary: { added_rows: rows.length, added_files: added.length },
      };
      meta.last_sequence += 1;
      meta.snapshots.push(snap);
      meta.current_snapshot_id = snap.snapshot_id;
      await this.commit(meta);
      return snap;
    });
  }

  async scan(filter?: (row: Row) => boolean): Promise<Row[]> {
    const meta = await this.metadata();
    const snap = this.current(meta);
    if (!snap) return [];
    const out: Row[] = [];
    for (const f of snap.data_files) for (const r of await this.readFile(f)) if (!filter || filter(r)) out.push(r);
    return out;
  }

  /**
   * Removes matching rows, rewriting only the files that contain them, then expires every
   * older snapshot and deletes files no longer referenced. Returns the number of rows removed.
   */
  deleteWhere(predicate: (row: Row) => boolean, reason: string): Promise<number> {
    return this.exclusive(async () => {
      const meta = await this.loadForCommit();
      const snap = this.current(meta);
      if (!snap) return 0;
      let removed = 0;
      const kept: DataFile[] = [];
      for (const f of snap.data_files) {
        const rows = await this.readFile(f);
        const survivors = rows.filter((r) => !predicate(r));
        if (survivors.length === rows.length) {
          kept.push(f);
          continue;
        }
        removed += rows.length - survivors.length;
        if (survivors.length) kept.push(await this.writeFile(f.partition, survivors));
      }
      if (removed === 0) return 0;
      const next: Snapshot = {
        snapshot_id: randomUUID(),
        parent_id: null,
        committed_at: new Date().toISOString(),
        operation: "delete",
        data_files: kept,
        summary: { deleted_rows: removed, reason },
      };
      const live = new Set(kept.map((f) => f.path));
      const orphans = new Set<string>();
      for (const s of meta.snapshots) for (const f of s.data_files) if (!live.has(f.path)) orphans.add(f.path);
      meta.last_sequence += 1;
      meta.snapshots = [next];
      meta.current_snapshot_id = next.snapshot_id;
      await this.commit(meta);
      for (const p of orphans) await this.store.delete(p);
      return removed;
    });
  }

  /** Replaces the whole table contents (used to rebuild curated tables). */
  overwrite(rows: Row[], partitionOf: (row: Row) => string, reason: string): Promise<void> {
    return this.exclusive(async () => {
      const meta = await this.loadForCommit();
      const groups = new Map<string, Row[]>();
      for (const r of rows) {
        const p = partitionOf(r);
        let g = groups.get(p);
        if (!g) groups.set(p, (g = []));
        g.push(r);
      }
      const files: DataFile[] = [];
      for (const [p, g] of groups) files.push(await this.writeFile(p, g));
      const old = new Set<string>();
      for (const s of meta.snapshots) for (const f of s.data_files) old.add(f.path);
      const snap: Snapshot = {
        snapshot_id: randomUUID(),
        parent_id: null,
        committed_at: new Date().toISOString(),
        operation: "overwrite",
        data_files: files,
        summary: { rows: rows.length, reason },
      };
      meta.last_sequence += 1;
      meta.snapshots = [snap];
      meta.current_snapshot_id = snap.snapshot_id;
      await this.commit(meta);
      for (const p of old) await this.store.delete(p);
    });
  }
}
