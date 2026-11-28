/**
 * Cumulus://Drive metadata as rows behind the nexus-store gateway (CUMULUS_ROWS=drive with
 * CUMULUS_STORE=gateway; supabase/migrations/20261122_cumulus_rows_drive.sql).
 *
 * The protocol of RemoteRows: reads go through public.cid_read and are remembered for the rest of the
 * request; writes stay here until the host commits, then pending() hands them to public.nexus_commit_cid,
 * in the same transaction as the ledger and documents. Each item write carries the item as this request
 * read it, so if another server changed it in the meantime the commit is refused and the request re-runs:
 * two saves of the same document can't both be kept. Items the request only read one at a time (a
 * folder it moved something into, the folders above an item it was allowed to change) are sent as checks:
 * if one of them changed meanwhile, the commit is refused too, so a decision made on them (no cycle, still
 * shared, still there) holds when it is saved.
 *
 * Requests on one instance must not overlap (RemoteState serializes them); begin() starts a fresh one.
 */
import type { DriveItem, WorkspaceRepository } from "./workspace.ts";

export type DriveReadOp =
  | { op: "driveItem"; id: string }
  | { op: "driveItemsOf"; owner: string }
  | { op: "driveChildren"; parent: string }
  | { op: "driveSharedWith"; cid: string }
  | { op: "driveEnabled"; cid: string };

export type DriveWriteOp =
  | { kind: "driveItem"; id: string; data: DriveItem | null; expect: DriveItem | null }
  /** Not a write: the item must still be as this request read it (null: still absent). */
  | { kind: "driveItem"; id: string; check: true; expect: DriveItem | null }
  | { kind: "driveEnabled"; id: string; data: string };

export type DriveRowsReader = (ops: DriveReadOp[]) => Promise<unknown[]>;

interface Known {
  value: DriveItem | null;
  /** As read from the server this request (null: didn't exist). */
  base: DriveItem | null;
  dirty: boolean;
  /** Read on its own (item()), so the request may have decided something on it. */
  relied?: boolean;
}

const copy = <T>(v: T): T => (v === undefined || v === null ? v : structuredClone(v));

export class RemoteWorkspaceRepository implements WorkspaceRepository {
  readonly #read: DriveRowsReader;
  #items = new Map<string, Known>();
  #enabled = new Map<string, { at: string | null; dirty: boolean }>();

  constructor(read: DriveRowsReader) {
    this.#read = read;
  }

  /** A new request (or a re-run): forget what was read and drop unsaved writes. */
  begin(): void {
    this.#items.clear();
    this.#enabled.clear();
  }

  /** The writes for nexus_commit_cid, in the order they can be applied. */
  pending(): DriveWriteOp[] {
    const out: DriveWriteOp[] = [];
    for (const [id, k] of this.#items) {
      if (k.dirty) out.push({ kind: "driveItem", id, data: copy(k.value), expect: copy(k.base) });
      else if (k.relied) out.push({ kind: "driveItem", id, check: true, expect: copy(k.base) });
    }
    for (const [cid, e] of this.#enabled) if (e.dirty && e.at) out.push({ kind: "driveEnabled", id: cid, data: e.at });
    return out;
  }

  async item(id: string): Promise<DriveItem | undefined> {
    let k = this.#items.get(id);
    if (!k) {
      const [row] = (await this.#read([{ op: "driveItem", id }])) as (DriveItem | null)[];
      k = this.#remember(id, row ?? null);
    }
    k.relied = true;
    return copy(k.value) ?? undefined;
  }

  async putItem(item: DriveItem): Promise<void> {
    const k = this.#items.get(item.id) ?? (await this.#known(item.id));
    k.value = copy(item);
    k.dirty = true;
  }

  async deleteItem(id: string): Promise<void> {
    const k = this.#items.get(id) ?? (await this.#known(id));
    k.value = null;
    k.dirty = true;
  }

  itemsOf(owner: string) {
    return this.#list({ op: "driveItemsOf", owner }, (i) => i.owner === owner);
  }

  children(parent: string) {
    return this.#list({ op: "driveChildren", parent }, (i) => i.parent === parent);
  }

  sharedWith(cid: string) {
    return this.#list({ op: "driveSharedWith", cid }, (i) => i.sharedWith.includes(cid));
  }

  async enabledAt(cid: string): Promise<string | undefined> {
    let e = this.#enabled.get(cid);
    if (!e) {
      const [at] = (await this.#read([{ op: "driveEnabled", cid }])) as (string | null)[];
      e = { at: at ?? null, dirty: false };
      this.#enabled.set(cid, e);
    }
    return e.at ?? undefined;
  }

  async setEnabled(cid: string, at: string): Promise<void> {
    if (await this.enabledAt(cid)) return; // the first time is kept
    this.#enabled.set(cid, { at, dirty: true });
  }

  /** An item written without being read first (a new one): read it, so the write checks what is there. */
  async #known(id: string): Promise<Known> {
    await this.item(id);
    return this.#items.get(id)!;
  }

  #remember(id: string, row: DriveItem | null): Known {
    const k = { value: copy(row), base: row, dirty: false };
    this.#items.set(id, k);
    return k;
  }

  /** The stored list, with this request's changes on top (an item it changed is checked as it is now). */
  async #list(op: DriveReadOp, matches: (item: DriveItem) => boolean): Promise<DriveItem[]> {
    const [stored] = (await this.#read([op])) as DriveItem[][];
    for (const row of stored ?? []) if (!this.#items.has(row.id)) this.#remember(row.id, row);
    const ids = new Set((stored ?? []).map((r) => r.id));
    for (const [id, k] of this.#items) if (k.dirty) ids.add(id);
    const out: DriveItem[] = [];
    for (const id of ids) {
      const value = this.#items.get(id)!.value;
      if (value && matches(value)) out.push(copy(value));
    }
    return out;
  }
}

/**
 * Keep Drive's rows with a host's RemoteState: reset with each request (and re-run), and hand the
 * writes over with the suite's at commit. Call after the suite's participant and rows are set, so the
 * first request's claim runs before Drive reads anything.
 */
export function attachDriveRows(
  state: { participants: { begin(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void> }[]; rows: { pending(): unknown[] } | null },
  read: DriveRowsReader,
): RemoteWorkspaceRepository {
  const drive = new RemoteWorkspaceRepository(read);
  const reset = async () => drive.begin();
  state.participants.push({ begin: reset, commit: reset, rollback: reset });
  const suite = state.rows;
  state.rows = { pending: () => [...(suite?.pending() ?? []), ...drive.pending()] };
  return drive;
}
