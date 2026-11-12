// © Infinitum Corporation®. All rights reserved.
/**
 * Object storage behind the lakehouse. The memory store is for tests; the filesystem store
 * writes atomically (temp file + rename). An R2/S3 store implements the same interface.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";

export interface ObjectStore {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.=\-/]*$/;

export function checkKey(key: string): string {
  if (!KEY_RE.test(key) || key.includes("..") || key.includes("//") || key.endsWith("/")) {
    throw new Error(`invalid object key: ${key}`);
  }
  return key;
}

export class MemoryObjectStore implements ObjectStore {
  private objects = new Map<string, Uint8Array>();
  async get(key: string): Promise<Uint8Array | undefined> {
    const v = this.objects.get(checkKey(key));
    return v ? new Uint8Array(v) : undefined;
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(checkKey(key), new Uint8Array(bytes));
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(checkKey(key));
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
  /** Every byte currently stored, for tests that prove data is physically gone. */
  dump(): string {
    const dec = new TextDecoder();
    return [...this.objects.values()].map((b) => dec.decode(b)).join("\n");
  }
}

export class FileObjectStore implements ObjectStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  private path(key: string): string {
    return join(this.root, ...checkKey(key).split("/"));
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const tmp = `${p}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes, { flush: true });
    await rename(tmp, p);
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
        throw e;
      }
      for (const ent of entries) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) await walk(full);
        else if (!ent.name.endsWith(".tmp")) out.push(relative(this.root, full).split(sep).join("/"));
      }
    };
    await walk(this.root);
    return out.filter((k) => k.startsWith(prefix)).sort();
  }
}
