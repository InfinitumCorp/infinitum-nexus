/**
 * Cumulus://Drive and the office apps that keep their files in it:
 *   Cumulus://Dox     documents (rich text)
 *   Cumulus://Spreads spreadsheets (cells and formulas)
 *   Cumulus://Podium  presentations (slides)
 *
 * Metadata (names, folders, sharing, sizes) lives in the shared state with the rest of Cumulus.
 * Contents live in the file store (R2 on Workers): `d/{owner}/{id}` for uploads and
 * `d/{owner}/{id}.json` for documents. Everything counts against the account's shared storage
 * quota (Mail and Drive together).
 *
 * Access: the owner can do everything. People a file is shared with can open it and edit its
 * contents (documents), but can't rename, move, share or delete it. Sharing a folder shares
 * everything inside it.
 */
import { randomUUID } from "node:crypto";
import type { StorageQuota } from "@infinitum/cloud";
import type { FileStore } from "./files.ts";

export type ItemKind = "folder" | "file" | "dox" | "spreads" | "podium";
export const DOC_KINDS = ["dox", "spreads", "podium"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export interface DriveItem {
  id: string;
  owner: string;
  parent: string | null;
  name: string;
  kind: ItemKind;
  /** Bytes stored for this item (0 for folders). */
  size: number;
  /** Content type of an uploaded file. */
  type?: string;
  /** Bumped on every content save; editors send it back to catch overwrites. */
  version: number;
  createdAt: string;
  updatedAt: string;
  updatedBy?: string;
  starred?: boolean;
  trashedAt?: string;
  sharedWith: string[];
  /**
   * Where a document's contents are (a new key on every save, so a save that loses a race can't
   * overwrite the one that won). Absent: the original key, from before keys changed per save.
   */
  blob?: string;
  /** The contents before the last save: still read by a request that started before it, deleted on the next save. */
  previousBlob?: string;
}

/** Kept in the shared state. Map fields are saved generically by RemoteState. */
export class WorkspaceStore {
  items = new Map<string, DriveItem>();
  /** CIDs that have opened Drive once (so a later revocation in CID permissions sticks). */
  enabled = new Map<string, string>();
}

export class DriveError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Largest upload through the Worker, and largest saved document. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MAX_DOC_BYTES = 8 * 1024 * 1024;
const MAX_NAME = 200;
const MAX_DEPTH = 32;

const EXT: Record<DocKind, string> = { dox: "Untitled document", spreads: "Untitled spreadsheet", podium: "Untitled presentation" };

/** Empty contents for a new document of each kind. */
export function emptyDoc(kind: DocKind): unknown {
  if (kind === "dox") return { html: "<p></p>" };
  if (kind === "spreads") return { sheets: [{ name: "Sheet1", cells: {} }] };
  return { theme: "paper", slides: [{ layout: "title", title: "", body: "" }] };
}

/** Checks a document's shape before it is saved, so editors can trust what they load. */
export function validDoc(kind: DocKind, doc: any): boolean {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return false;
  if (kind === "dox") return typeof doc.html === "string";
  if (kind === "spreads") {
    return Array.isArray(doc.sheets) && doc.sheets.length >= 1 && doc.sheets.length <= 50
      && doc.sheets.every((s: any) => s && typeof s.name === "string" && s.cells && typeof s.cells === "object" && !Array.isArray(s.cells)
        && Object.entries(s.cells).every(([k, v]) => /^[A-Z]{1,3}[1-9][0-9]{0,5}$/.test(k) && (typeof v === "string" || (v && typeof v === "object" && typeof (v as any).v === "string"))));
  }
  return Array.isArray(doc.slides) && doc.slides.length >= 1 && doc.slides.length <= 500
    && doc.slides.every((s: any) => s && typeof s === "object" && typeof s.title === "string" && typeof s.body === "string");
}

export const cleanName = (v: unknown, fallback = "Untitled") =>
  String(v ?? "").replace(/[\u0000-\u001f\u007f/\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME) || fallback;

const blobKey = (item: DriveItem) => item.blob ?? `d/${item.owner}/${item.id}${item.kind === "file" ? "" : ".json"}`;

/** Postgres re-runs a request that fails with this code (as after a deadlock); so does RemoteState. */
const rerun = (why: string) => Object.assign(new Error(why), { code: "40001" });

/**
 * Drive's storage boundary (relational storage plan): Workspace reads and writes items only through
 * these lookups, with every change an explicit put, so a database (drive_items) can replace the
 * in-memory store.
 */
export interface WorkspaceRepository {
  item(id: string): Promise<DriveItem | undefined>;
  putItem(item: DriveItem): Promise<void>;
  deleteItem(id: string): Promise<void>;
  /** Everything a person owns, in any folder or the trash. */
  itemsOf(owner: string): Promise<DriveItem[]>;
  /** What is directly inside a folder (any owner). */
  children(parent: string): Promise<DriveItem[]>;
  /** Items shared directly with a person (not what sits inside them). */
  sharedWith(cid: string): Promise<DriveItem[]>;
  /** When the person first opened Drive. */
  enabledAt(cid: string): Promise<string | undefined>;
  setEnabled(cid: string, at: string): Promise<void>;
}

/** Today's WorkspaceStore Maps, snapshot format unchanged. */
export class MapWorkspaceRepository implements WorkspaceRepository {
  readonly store: WorkspaceStore;
  constructor(store: WorkspaceStore) {
    this.store = store;
  }
  async item(id: string) { return this.store.items.get(id); }
  async putItem(item: DriveItem) { this.store.items.set(item.id, item); }
  async deleteItem(id: string) { this.store.items.delete(id); }
  async itemsOf(owner: string) { return [...this.store.items.values()].filter((i) => i.owner === owner); }
  async children(parent: string) { return [...this.store.items.values()].filter((i) => i.parent === parent); }
  async sharedWith(cid: string) { return [...this.store.items.values()].filter((i) => i.sharedWith.includes(cid)); }
  async enabledAt(cid: string) { return this.store.enabled.get(cid); }
  async setEnabled(cid: string, at: string) { this.store.enabled.set(cid, at); }
}

/** Test double that copies values in and out, as a database does. */
export class CopyingWorkspaceRepository implements WorkspaceRepository {
  readonly #inner: MapWorkspaceRepository;
  constructor(store: WorkspaceStore) {
    this.#inner = new MapWorkspaceRepository(store);
  }
  async item(id: string) { return structuredClone(await this.#inner.item(id)); }
  async putItem(item: DriveItem) { return this.#inner.putItem(structuredClone(item)); }
  async deleteItem(id: string) { return this.#inner.deleteItem(id); }
  async itemsOf(owner: string) { return structuredClone(await this.#inner.itemsOf(owner)); }
  async children(parent: string) { return structuredClone(await this.#inner.children(parent)); }
  async sharedWith(cid: string) { return structuredClone(await this.#inner.sharedWith(cid)); }
  async enabledAt(cid: string) { return this.#inner.enabledAt(cid); }
  async setEnabled(cid: string, at: string) { return this.#inner.setEnabled(cid, at); }
}

export interface WorkspaceDeps {
  /** In-memory Drive metadata (snapshotted as the cumulus-workspace document). Ignored with `repository`. */
  store?: WorkspaceStore;
  /** Where Drive items live; defaults to a MapWorkspaceRepository over `store`. */
  repository?: WorkspaceRepository;
  quota: StorageQuota;
  files?: FileStore;
  /**
   * Runs a step once the request's changes are saved (RemoteState.afterCommit), never if they are rolled
   * back or re-run. Stored files are deleted this way. Without it, steps run at once.
   */
  afterCommit?: (fn: () => Promise<void>) => void;
  /** Turns a username or address into a CID, for sharing. */
  resolve: (who: string) => Promise<string | undefined> | string | undefined;
  /** Display name (address) of a CID, for "Shared with" lists. */
  label: (cid: string) => Promise<string> | string;
  clock?: () => Date;
}

export class Workspace {
  private readonly d: WorkspaceDeps;
  readonly repo: WorkspaceRepository;
  constructor(deps: WorkspaceDeps) {
    this.d = deps;
    this.repo = deps.repository ?? new MapWorkspaceRepository(deps.store ?? new WorkspaceStore());
  }

  private now() {
    return (this.d.clock?.() ?? new Date()).toISOString();
  }
  private bucket(): FileStore {
    if (!this.d.files) throw new DriveError(503, "unavailable", "File storage isn't available yet.");
    return this.d.files;
  }
  private async parentOf(item: DriveItem): Promise<DriveItem | undefined> {
    return item.parent ? this.repo.item(item.parent) : undefined;
  }

  /* ---------------- access ---------------- */

  /** True when the item, or a folder it sits in, is shared with this CID. */
  private async sharedTo(cid: string, item: DriveItem): Promise<boolean> {
    let cur: DriveItem | undefined = item;
    for (let i = 0; cur && i < MAX_DEPTH; i++) {
      if (cur.sharedWith.includes(cid)) return true;
      cur = await this.parentOf(cur);
    }
    return false;
  }

  private async find(cid: string, id: string, need: "read" | "own"): Promise<DriveItem> {
    const item = await this.repo.item(id);
    if (!item) throw new DriveError(404, "not_found", "That file doesn't exist or was deleted.");
    const mine = item.owner === cid;
    if (need === "own" ? !mine : !(mine || (await this.sharedTo(cid, item)))) throw new DriveError(404, "not_found", "That file doesn't exist or was deleted.");
    if (!mine && (await this.inTrash(item))) throw new DriveError(404, "not_found", "That file was deleted.");
    return item;
  }

  private async inTrash(item: DriveItem): Promise<boolean> {
    let cur: DriveItem | undefined = item;
    for (let i = 0; cur && i < MAX_DEPTH; i++) {
      if (cur.trashedAt) return true;
      cur = await this.parentOf(cur);
    }
    return false;
  }

  private async folder(cid: string, id: string | null | undefined): Promise<string | null> {
    if (!id || id === "root") return null;
    const f = await this.find(cid, id, "own");
    if (f.kind !== "folder") throw new DriveError(400, "not_folder", "That isn't a folder.");
    if (f.trashedAt) throw new DriveError(400, "trashed", "That folder is in the trash.");
    return f.id;
  }

  /** Delete a stored file once this request is saved: a deletion that is rolled back must keep its contents. */
  private deleteFile(key: string): void {
    const files = this.d.files;
    if (!files?.delete) return;
    const run = () => files.delete!(key).catch(() => undefined);
    if (this.d.afterCommit) this.d.afterCommit(run);
    else void run();
  }

  /** An item and everything inside it, at any depth. */
  private async withDescendants(top: DriveItem[]): Promise<DriveItem[]> {
    const out: DriveItem[] = [];
    const seen = new Set<string>();
    const queue = [...top];
    while (queue.length && out.length < 10_000) {
      const item = queue.shift()!;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      if (item.kind === "folder") queue.push(...(await this.repo.children(item.id)));
    }
    return out;
  }

  /** Enabling Drive the first time; afterwards CID permissions decide. */
  async firstVisit(cid: string): Promise<boolean> {
    if (await this.repo.enabledAt(cid)) return false;
    await this.repo.setEnabled(cid, this.now());
    return true;
  }

  /* ---------------- listing ---------------- */

  async view(cid: string, item: DriveItem) {
    const role = item.owner === cid ? "owner" : "editor";
    const label = (c: string) => this.d.label(c);
    return {
      id: item.id, name: item.name, kind: item.kind, size: item.size, type: item.type, version: item.version,
      parent: item.owner === cid ? item.parent : null, createdAt: item.createdAt, updatedAt: item.updatedAt,
      starred: item.owner === cid ? !!item.starred : false, trashed: !!item.trashedAt, role,
      owner: await label(item.owner), updatedBy: item.updatedBy ? await label(item.updatedBy) : undefined,
      sharedWith: role === "owner" ? await Promise.all(item.sharedWith.map(label)) : [],
    };
  }

  /** Breadcrumb from My Drive down to a folder. */
  async path(cid: string, folderId: string | null) {
    const out: { id: string; name: string }[] = [];
    let cur = folderId ? await this.repo.item(folderId) : undefined;
    for (let i = 0; cur && i < MAX_DEPTH; i++) {
      out.unshift({ id: cur.id, name: cur.name });
      if (cur.owner !== cid && cur.sharedWith.includes(cid)) break; // top of what was shared with them
      cur = await this.parentOf(cur);
    }
    return out;
  }

  async list(cid: string, opts: { folder?: string | null; view?: string; q?: string } = {}) {
    const sort = (a: DriveItem, b: DriveItem) => (a.kind === "folder" ? 0 : 1) - (b.kind === "folder" ? 0 : 1) || a.name.localeCompare(b.name);
    const notTrashed = async (items: DriveItem[]) => {
      const keep: DriveItem[] = [];
      for (const i of items) if (!(await this.inTrash(i))) keep.push(i);
      return keep;
    };
    /** What this person can open: their own items, and everything inside what was shared with them. */
    const reachable = async () => {
      const own = await this.repo.itemsOf(cid);
      const shared = (await this.withDescendants(await this.repo.sharedWith(cid))).filter((i) => i.owner !== cid);
      return [...own, ...shared];
    };
    let list: DriveItem[];
    let folder: string | null = null;
    const view = opts.view ?? "drive";
    if (opts.q) {
      const q = opts.q.toLowerCase();
      list = (await notTrashed((await reachable()).filter((i) => i.name.toLowerCase().includes(q)))).sort(sort).slice(0, 200);
    } else if (view === "recent") {
      list = (await notTrashed((await reachable()).filter((i) => i.kind !== "folder")))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50);
    } else if (view === "starred") {
      list = (await notTrashed((await this.repo.itemsOf(cid)).filter((i) => i.starred))).sort(sort);
    } else if (view === "shared") {
      list = (await notTrashed((await this.repo.sharedWith(cid)).filter((i) => i.owner !== cid))).sort(sort);
    } else if (view === "trash") {
      const trashed: DriveItem[] = [];
      for (const i of await this.repo.itemsOf(cid)) {
        if (!i.trashedAt) continue;
        const parent = await this.parentOf(i);
        if (!(parent && (await this.inTrash(parent)))) trashed.push(i);
      }
      list = trashed.sort(sort);
    } else {
      if (opts.folder && opts.folder !== "root") {
        const f = await this.find(cid, opts.folder, "read");
        if (f.kind !== "folder") throw new DriveError(400, "not_folder", "That isn't a folder.");
        folder = f.id;
        list = (await this.repo.children(f.id)).filter((i) => !i.trashedAt).sort(sort);
      } else {
        list = (await this.repo.itemsOf(cid)).filter((i) => i.parent === null && !i.trashedAt).sort(sort);
      }
    }
    const usage = await this.d.quota.usage(cid);
    return { view, folder, path: await this.path(cid, folder), items: await Promise.all(list.map((i) => this.view(cid, i))), usage };
  }

  async get(cid: string, id: string) {
    return await this.view(cid, await this.find(cid, id, "read"));
  }

  /* ---------------- creating ---------------- */

  private async add(cid: string, fields: Pick<DriveItem, "parent" | "name" | "kind" | "size"> & Partial<DriveItem>): Promise<DriveItem> {
    const at = this.now();
    const item: DriveItem = { id: randomUUID(), owner: cid, version: 1, createdAt: at, updatedAt: at, updatedBy: cid, sharedWith: [], ...fields };
    await this.repo.putItem(item);
    return item;
  }

  async createFolder(cid: string, name: unknown, parent?: string | null) {
    const p = await this.folder(cid, parent);
    return await this.view(cid, await this.add(cid, { parent: p, name: cleanName(name, "Untitled folder"), kind: "folder", size: 0 }));
  }

  async createDoc(cid: string, kind: DocKind, name: unknown, parent?: string | null, content?: unknown) {
    if (!DOC_KINDS.includes(kind)) throw new DriveError(400, "bad_kind", "Unknown document type.");
    const p = await this.folder(cid, parent);
    const doc = content !== undefined && validDoc(kind, content) ? content : emptyDoc(kind);
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    if (bytes.byteLength > MAX_DOC_BYTES) throw new DriveError(413, "too_large", "That document is too large.");
    await this.d.quota.charge(cid, "cloud", bytes.byteLength);
    const item = await this.add(cid, { parent: p, name: cleanName(name, EXT[kind]), kind, size: bytes.byteLength, type: "application/json" });
    try {
      await this.bucket().put(blobKey(item), bytes, "application/json");
    } catch (err) {
      await this.repo.deleteItem(item.id);
      await this.d.quota.release(cid, "cloud", bytes.byteLength);
      throw err;
    }
    return await this.view(cid, item);
  }

  async upload(cid: string, name: unknown, parent: string | null | undefined, data: Uint8Array, type: string) {
    if (data.byteLength > MAX_UPLOAD_BYTES) throw new DriveError(413, "too_large", "Files up to 50 MB can be uploaded here.");
    const p = await this.folder(cid, parent);
    await this.d.quota.charge(cid, "cloud", data.byteLength);
    const item = await this.add(cid, { parent: p, name: cleanName(name, "file"), kind: "file", size: data.byteLength, type });
    try {
      await this.bucket().put(blobKey(item), data, type);
    } catch (err) {
      await this.repo.deleteItem(item.id);
      await this.d.quota.release(cid, "cloud", data.byteLength);
      throw err;
    }
    return await this.view(cid, item);
  }

  /* ---------------- contents ---------------- */

  async download(cid: string, id: string) {
    const item = await this.find(cid, id, "read");
    if (item.kind === "folder") throw new DriveError(400, "not_file", "Folders can't be downloaded.");
    const blob = await this.bucket().get(blobKey(item));
    if (!blob) throw new DriveError(404, "missing", "That file's contents are missing.");
    return { item, data: blob.data, type: item.kind === "file" ? (item.type ?? blob.type) : "application/json" };
  }

  async readDoc(cid: string, id: string) {
    const item = await this.find(cid, id, "read");
    if (!(DOC_KINDS as readonly string[]).includes(item.kind)) throw new DriveError(400, "not_doc", "That isn't a document.");
    const blob = await this.bucket().get(blobKey(item));
    let doc: unknown = emptyDoc(item.kind as DocKind);
    if (blob) {
      try {
        doc = JSON.parse(new TextDecoder().decode(blob.data));
      } catch { /* damaged: open empty rather than fail */ }
    }
    return { item: await this.view(cid, item), doc };
  }

  /** Saves a document. `baseVersion` must match, so two editors can't silently overwrite each other. */
  async saveDoc(cid: string, id: string, doc: unknown, baseVersion: number) {
    const item = await this.find(cid, id, "read");
    if (!(DOC_KINDS as readonly string[]).includes(item.kind)) throw new DriveError(400, "not_doc", "That isn't a document.");
    if (item.trashedAt) throw new DriveError(400, "trashed", "Restore this document from the trash to edit it.");
    if (!validDoc(item.kind as DocKind, doc)) throw new DriveError(400, "bad_doc", "That document couldn't be saved: its contents aren't valid.");
    if (baseVersion !== item.version) {
      throw new DriveError(409, "conflict", `${item.updatedBy && item.updatedBy !== cid ? await this.d.label(item.updatedBy) : "Someone"} changed this document since you opened it. Reload to see their changes.`);
    }
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    if (bytes.byteLength > MAX_DOC_BYTES) throw new DriveError(413, "too_large", "That document is too large to save (8 MB at most).");
    const delta = bytes.byteLength - item.size;
    if (delta > 0) await this.d.quota.charge(item.owner, "cloud", delta);
    else if (delta < 0) await this.d.quota.release(item.owner, "cloud", -delta);
    const key = `d/${item.owner}/${item.id}/${randomUUID()}.json`;
    try {
      await this.bucket().put(key, bytes, "application/json");
    } catch (err) {
      if (delta > 0) await this.d.quota.release(item.owner, "cloud", delta);
      else if (delta < 0) await this.d.quota.charge(item.owner, "cloud", -delta);
      throw err;
    }
    // What the saved item points to is the only thing a later reader sees: the contents before this save
    // stay for requests already reading them; the ones before that no saved item points to any more.
    const stale = item.previousBlob;
    item.previousBlob = blobKey(item);
    item.blob = key;
    item.size = bytes.byteLength;
    item.version += 1;
    item.updatedAt = this.now();
    item.updatedBy = cid;
    await this.repo.putItem(item);
    if (stale) this.deleteFile(stale);
    return await this.view(cid, item);
  }

  /* ---------------- organizing ---------------- */

  async update(cid: string, id: string, changes: { name?: unknown; parent?: unknown; starred?: unknown; trashed?: unknown }) {
    const item = await this.find(cid, id, "own");
    if (changes.name !== undefined) item.name = cleanName(changes.name, item.name);
    if (changes.parent !== undefined) {
      const target = await this.folder(cid, changes.parent === null ? null : String(changes.parent));
      // A folder can't move inside itself.
      let cur = target ? await this.repo.item(target) : undefined;
      for (let i = 0; cur && i < MAX_DEPTH; i++) {
        if (cur.id === item.id) throw new DriveError(400, "cycle", "A folder can't go inside itself.");
        cur = await this.parentOf(cur);
      }
      item.parent = target;
    }
    if (changes.starred !== undefined) item.starred = !!changes.starred;
    if (changes.trashed !== undefined) {
      if (changes.trashed) item.trashedAt ??= this.now();
      else {
        delete item.trashedAt;
        if (item.parent && (await this.repo.item(item.parent))?.trashedAt) item.parent = null; // its folder is still in the trash
      }
    }
    item.updatedAt = this.now();
    await this.repo.putItem(item);
    return await this.view(cid, item);
  }

  /** Deletes for good: the item and everything inside it. It must be in the trash first. */
  async remove(cid: string, id: string) {
    const item = await this.find(cid, id, "own");
    if (!item.trashedAt) throw new DriveError(400, "not_trashed", "Move it to the trash first.");
    const doomed = await this.withDescendants([item]);
    let removed = 0;
    for (const listed of doomed) {
      // Read each one again (on Postgres this takes its row lock): a save that just finished changed its size.
      const d = await this.repo.item(listed.id);
      if (!d) continue;
      await this.repo.deleteItem(d.id);
      removed++;
      if (d.size) await this.d.quota.release(d.owner, "cloud", d.size);
      if (d.kind !== "folder") {
        this.deleteFile(blobKey(d));
        if (d.previousBlob) this.deleteFile(d.previousBlob);
      }
    }
    // Something was added to one of these folders meanwhile (an upload that finished first): it would be
    // left inside a folder that's gone. Run the deletion again, so it goes too.
    for (const f of doomed) {
      if (f.kind === "folder" && (await this.repo.children(f.id)).length) throw rerun("A folder being deleted got new contents meanwhile");
    }
    return { removed };
  }

  async emptyTrash(cid: string) {
    const top = (await this.repo.itemsOf(cid)).filter((i) => i.trashedAt);
    let removed = 0;
    for (const t of top) if (await this.repo.item(t.id)) removed += (await this.remove(cid, t.id)).removed;
    return { removed };
  }

  /* ---------------- sharing ---------------- */

  async share(cid: string, id: string, who: unknown) {
    const item = await this.find(cid, id, "own");
    const target = await this.d.resolve(String(who ?? "").trim().toLowerCase());
    if (!target) throw new DriveError(404, "no_such_user", "There's no Cumulus://ID with that name.");
    if (target === cid) throw new DriveError(400, "self", "That's you.");
    if (!item.sharedWith.includes(target)) {
      if (item.sharedWith.length >= 100) throw new DriveError(400, "too_many", "A file can be shared with 100 people at most.");
      item.sharedWith.push(target);
      await this.repo.putItem(item);
    }
    return { item: await this.view(cid, item), target };
  }

  async unshare(cid: string, id: string, who: unknown) {
    const item = await this.find(cid, id, "own");
    const target = await this.d.resolve(String(who ?? "").trim().toLowerCase());
    item.sharedWith = item.sharedWith.filter((c) => c !== target);
    await this.repo.putItem(item);
    return await this.view(cid, item);
  }

  /** Someone leaves a file that was shared with them. */
  async leave(cid: string, id: string) {
    const item = await this.repo.item(id);
    if (item && item.sharedWith.includes(cid)) {
      item.sharedWith = item.sharedWith.filter((c) => c !== cid);
      await this.repo.putItem(item);
    }
    return { ok: true };
  }
}
