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

const blobKey = (item: DriveItem) => `d/${item.owner}/${item.id}${item.kind === "file" ? "" : ".json"}`;

export interface WorkspaceDeps {
  store: WorkspaceStore;
  quota: StorageQuota;
  files?: FileStore;
  /** Turns a username or address into a CID, for sharing. */
  resolve: (who: string) => Promise<string | undefined> | string | undefined;
  /** Display name (address) of a CID, for "Shared with" lists. */
  label: (cid: string) => Promise<string> | string;
  clock?: () => Date;
}

export class Workspace {
  private readonly d: WorkspaceDeps;
  constructor(deps: WorkspaceDeps) {
    this.d = deps;
  }

  private now() {
    return (this.d.clock?.() ?? new Date()).toISOString();
  }
  private get items() {
    return this.d.store.items;
  }
  private bucket(): FileStore {
    if (!this.d.files) throw new DriveError(503, "unavailable", "File storage isn't available yet.");
    return this.d.files;
  }

  /* ---------------- access ---------------- */

  /** True when the item, or a folder it sits in, is shared with this CID. */
  private sharedTo(cid: string, item: DriveItem): boolean {
    let cur: DriveItem | undefined = item;
    for (let i = 0; cur && i < MAX_DEPTH; i++) {
      if (cur.sharedWith.includes(cid)) return true;
      cur = cur.parent ? this.items.get(cur.parent) : undefined;
    }
    return false;
  }

  private find(cid: string, id: string, need: "read" | "own"): DriveItem {
    const item = this.items.get(id);
    if (!item) throw new DriveError(404, "not_found", "That file doesn't exist or was deleted.");
    const mine = item.owner === cid;
    if (need === "own" ? !mine : !(mine || this.sharedTo(cid, item))) throw new DriveError(404, "not_found", "That file doesn't exist or was deleted.");
    if (!mine && this.inTrash(item)) throw new DriveError(404, "not_found", "That file was deleted.");
    return item;
  }

  private inTrash(item: DriveItem): boolean {
    let cur: DriveItem | undefined = item;
    for (let i = 0; cur && i < MAX_DEPTH; i++) {
      if (cur.trashedAt) return true;
      cur = cur.parent ? this.items.get(cur.parent) : undefined;
    }
    return false;
  }

  private folder(cid: string, id: string | null | undefined): string | null {
    if (!id || id === "root") return null;
    const f = this.find(cid, id, "own");
    if (f.kind !== "folder") throw new DriveError(400, "not_folder", "That isn't a folder.");
    if (f.trashedAt) throw new DriveError(400, "trashed", "That folder is in the trash.");
    return f.id;
  }

  /** Enabling Drive the first time; afterwards CID permissions decide. */
  firstVisit(cid: string): boolean {
    if (this.d.store.enabled.has(cid)) return false;
    this.d.store.enabled.set(cid, this.now());
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
  path(cid: string, folderId: string | null) {
    const out: { id: string; name: string }[] = [];
    let cur = folderId ? this.items.get(folderId) : undefined;
    for (let i = 0; cur && i < MAX_DEPTH; i++) {
      out.unshift({ id: cur.id, name: cur.name });
      if (cur.owner !== cid && cur.sharedWith.includes(cid)) break; // top of what was shared with them
      cur = cur.parent ? this.items.get(cur.parent) : undefined;
    }
    return out;
  }

  async list(cid: string, opts: { folder?: string | null; view?: string; q?: string } = {}) {
    const all = [...this.items.values()];
    const sort = (a: DriveItem, b: DriveItem) => (a.kind === "folder" ? 0 : 1) - (b.kind === "folder" ? 0 : 1) || a.name.localeCompare(b.name);
    let list: DriveItem[];
    let folder: string | null = null;
    const view = opts.view ?? "drive";
    if (opts.q) {
      const q = opts.q.toLowerCase();
      list = all.filter((i) => (i.owner === cid || this.sharedTo(cid, i)) && !this.inTrash(i) && i.name.toLowerCase().includes(q)).sort(sort).slice(0, 200);
    } else if (view === "recent") {
      list = all.filter((i) => i.kind !== "folder" && (i.owner === cid || this.sharedTo(cid, i)) && !this.inTrash(i))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50);
    } else if (view === "starred") {
      list = all.filter((i) => i.owner === cid && i.starred && !this.inTrash(i)).sort(sort);
    } else if (view === "shared") {
      list = all.filter((i) => i.owner !== cid && i.sharedWith.includes(cid) && !this.inTrash(i)).sort(sort);
    } else if (view === "trash") {
      list = all.filter((i) => i.owner === cid && i.trashedAt && !(i.parent && this.inTrash(this.items.get(i.parent)!))).sort(sort);
    } else {
      if (opts.folder && opts.folder !== "root") {
        const f = this.find(cid, opts.folder, "read");
        if (f.kind !== "folder") throw new DriveError(400, "not_folder", "That isn't a folder.");
        folder = f.id;
        list = all.filter((i) => i.parent === folder && !i.trashedAt).sort(sort);
      } else {
        list = all.filter((i) => i.owner === cid && i.parent === null && !i.trashedAt).sort(sort);
      }
    }
    const usage = this.d.quota.usage(cid);
    return { view, folder, path: this.path(cid, folder), items: await Promise.all(list.map((i) => this.view(cid, i))), usage };
  }

  async get(cid: string, id: string) {
    return await this.view(cid, this.find(cid, id, "read"));
  }

  /* ---------------- creating ---------------- */

  private add(cid: string, fields: Pick<DriveItem, "parent" | "name" | "kind" | "size"> & Partial<DriveItem>): DriveItem {
    const at = this.now();
    const item: DriveItem = { id: randomUUID(), owner: cid, version: 1, createdAt: at, updatedAt: at, updatedBy: cid, sharedWith: [], ...fields };
    this.items.set(item.id, item);
    return item;
  }

  async createFolder(cid: string, name: unknown, parent?: string | null) {
    const p = this.folder(cid, parent);
    return await this.view(cid, this.add(cid, { parent: p, name: cleanName(name, "Untitled folder"), kind: "folder", size: 0 }));
  }

  async createDoc(cid: string, kind: DocKind, name: unknown, parent?: string | null, content?: unknown) {
    if (!DOC_KINDS.includes(kind)) throw new DriveError(400, "bad_kind", "Unknown document type.");
    const p = this.folder(cid, parent);
    const doc = content !== undefined && validDoc(kind, content) ? content : emptyDoc(kind);
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    if (bytes.byteLength > MAX_DOC_BYTES) throw new DriveError(413, "too_large", "That document is too large.");
    this.d.quota.charge(cid, "cloud", bytes.byteLength);
    const item = this.add(cid, { parent: p, name: cleanName(name, EXT[kind]), kind, size: bytes.byteLength, type: "application/json" });
    try {
      await this.bucket().put(blobKey(item), bytes, "application/json");
    } catch (err) {
      this.items.delete(item.id);
      this.d.quota.release(cid, "cloud", bytes.byteLength);
      throw err;
    }
    return await this.view(cid, item);
  }

  async upload(cid: string, name: unknown, parent: string | null | undefined, data: Uint8Array, type: string) {
    if (data.byteLength > MAX_UPLOAD_BYTES) throw new DriveError(413, "too_large", "Files up to 50 MB can be uploaded here.");
    const p = this.folder(cid, parent);
    this.d.quota.charge(cid, "cloud", data.byteLength);
    const item = this.add(cid, { parent: p, name: cleanName(name, "file"), kind: "file", size: data.byteLength, type });
    try {
      await this.bucket().put(blobKey(item), data, type);
    } catch (err) {
      this.items.delete(item.id);
      this.d.quota.release(cid, "cloud", data.byteLength);
      throw err;
    }
    return await this.view(cid, item);
  }

  /* ---------------- contents ---------------- */

  async download(cid: string, id: string) {
    const item = this.find(cid, id, "read");
    if (item.kind === "folder") throw new DriveError(400, "not_file", "Folders can't be downloaded.");
    const blob = await this.bucket().get(blobKey(item));
    if (!blob) throw new DriveError(404, "missing", "That file's contents are missing.");
    return { item, data: blob.data, type: item.kind === "file" ? (item.type ?? blob.type) : "application/json" };
  }

  async readDoc(cid: string, id: string) {
    const item = this.find(cid, id, "read");
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
    const item = this.find(cid, id, "read");
    if (!(DOC_KINDS as readonly string[]).includes(item.kind)) throw new DriveError(400, "not_doc", "That isn't a document.");
    if (item.trashedAt) throw new DriveError(400, "trashed", "Restore this document from the trash to edit it.");
    if (!validDoc(item.kind as DocKind, doc)) throw new DriveError(400, "bad_doc", "That document couldn't be saved: its contents aren't valid.");
    if (baseVersion !== item.version) {
      throw new DriveError(409, "conflict", `${item.updatedBy && item.updatedBy !== cid ? await this.d.label(item.updatedBy) : "Someone"} changed this document since you opened it. Reload to see their changes.`);
    }
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    if (bytes.byteLength > MAX_DOC_BYTES) throw new DriveError(413, "too_large", "That document is too large to save (8 MB at most).");
    const delta = bytes.byteLength - item.size;
    if (delta > 0) this.d.quota.charge(item.owner, "cloud", delta);
    else if (delta < 0) this.d.quota.release(item.owner, "cloud", -delta);
    try {
      await this.bucket().put(blobKey(item), bytes, "application/json");
    } catch (err) {
      if (delta > 0) this.d.quota.release(item.owner, "cloud", delta);
      else if (delta < 0) this.d.quota.charge(item.owner, "cloud", -delta);
      throw err;
    }
    item.size = bytes.byteLength;
    item.version += 1;
    item.updatedAt = this.now();
    item.updatedBy = cid;
    return await this.view(cid, item);
  }

  /* ---------------- organizing ---------------- */

  async update(cid: string, id: string, changes: { name?: unknown; parent?: unknown; starred?: unknown; trashed?: unknown }) {
    const item = this.find(cid, id, "own");
    if (changes.name !== undefined) item.name = cleanName(changes.name, item.name);
    if (changes.parent !== undefined) {
      const target = this.folder(cid, changes.parent === null ? null : String(changes.parent));
      // A folder can't move inside itself.
      for (let cur = target ? this.items.get(target) : undefined, i = 0; cur && i < MAX_DEPTH; cur = cur.parent ? this.items.get(cur.parent) : undefined, i++) {
        if (cur.id === item.id) throw new DriveError(400, "cycle", "A folder can't go inside itself.");
      }
      item.parent = target;
    }
    if (changes.starred !== undefined) item.starred = !!changes.starred;
    if (changes.trashed !== undefined) {
      if (changes.trashed) item.trashedAt ??= this.now();
      else {
        delete item.trashedAt;
        if (item.parent && this.items.get(item.parent)?.trashedAt) item.parent = null; // its folder is still in the trash
      }
    }
    item.updatedAt = this.now();
    return await this.view(cid, item);
  }

  /** Deletes for good: the item and everything inside it. It must be in the trash first. */
  async remove(cid: string, id: string) {
    const item = this.find(cid, id, "own");
    if (!item.trashedAt) throw new DriveError(400, "not_trashed", "Move it to the trash first.");
    const doomed = [item];
    for (let i = 0; i < doomed.length; i++) for (const c of this.items.values()) if (c.parent === doomed[i]!.id) doomed.push(c);
    for (const d of doomed) {
      this.items.delete(d.id);
      if (d.size) this.d.quota.release(d.owner, "cloud", d.size);
      if (d.kind !== "folder") await this.d.files?.delete?.(blobKey(d)).catch(() => undefined);
    }
    return { removed: doomed.length };
  }

  async emptyTrash(cid: string) {
    const top = [...this.items.values()].filter((i) => i.owner === cid && i.trashedAt);
    let removed = 0;
    for (const t of top) if (this.items.has(t.id)) removed += (await this.remove(cid, t.id)).removed;
    return { removed };
  }

  /* ---------------- sharing ---------------- */

  async share(cid: string, id: string, who: unknown) {
    const item = this.find(cid, id, "own");
    const target = await this.d.resolve(String(who ?? "").trim().toLowerCase());
    if (!target) throw new DriveError(404, "no_such_user", "There's no Cumulus://ID with that name.");
    if (target === cid) throw new DriveError(400, "self", "That's you.");
    if (!item.sharedWith.includes(target)) {
      if (item.sharedWith.length >= 100) throw new DriveError(400, "too_many", "A file can be shared with 100 people at most.");
      item.sharedWith.push(target);
    }
    return { item: await this.view(cid, item), target };
  }

  async unshare(cid: string, id: string, who: unknown) {
    const item = this.find(cid, id, "own");
    const target = await this.d.resolve(String(who ?? "").trim().toLowerCase());
    item.sharedWith = item.sharedWith.filter((c) => c !== target);
    return await this.view(cid, item);
  }

  /** Someone leaves a file that was shared with them. */
  leave(cid: string, id: string) {
    const item = this.items.get(id);
    if (item) item.sharedWith = item.sharedWith.filter((c) => c !== cid);
    return { ok: true };
  }
}
