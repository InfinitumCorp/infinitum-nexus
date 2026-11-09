import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Entry } from "./ledger.ts";

/** Storage backend. Swap in Postgres (Cumulus Database) or a node network without touching ledger logic. */
export interface LedgerStore {
  append(entry: Entry): Promise<void>;
  last(): Promise<Entry | undefined>;
  all(): Promise<Entry[]>;
}

export class MemoryStore implements LedgerStore {
  protected items: Entry[] = [];
  async append(entry: Entry) {
    this.items.push(entry);
  }
  async last() {
    return this.items[this.items.length - 1];
  }
  async all() {
    return [...this.items];
  }
}

/** Append-only JSON Lines file: one entry per line, never rewritten. */
export class FileStore implements LedgerStore {
  private cache?: Entry[];
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }

  private async load(): Promise<Entry[]> {
    if (this.cache) return this.cache;
    try {
      let text = await readFile(this.path, "utf8");
      // A crash mid-append leaves a partial last line. Drop it, or the next append
      // would glue onto it and the whole chain would fail to parse.
      if (text.length > 0 && !text.endsWith("\n")) {
        const cut = text.lastIndexOf("\n");
        text = cut === -1 ? "" : text.slice(0, cut + 1);
        await writeFile(this.path, text);
      }
      this.cache = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.cache = [];
    }
    return this.cache;
  }

  async append(entry: Entry) {
    const items = await this.load();
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(entry) + "\n");
    items.push(entry);
  }
  async last() {
    const items = await this.load();
    return items[items.length - 1];
  }
  async all() {
    return [...(await this.load())];
  }
}
