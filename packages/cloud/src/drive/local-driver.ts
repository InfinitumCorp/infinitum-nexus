import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BlobListing, BlobRange, BlobStore, StoredBlob } from "./driver.ts";
import { DriveError } from "./errors.ts";

/** Generated keys only: lowercase, no dot segments, no absolute paths. */
const KEY = /^[a-z0-9][a-z0-9/_-]{0,180}$/;
/** Names putStream gives its temporary files (and their checksum sidecars). */
const TEMP_NAME = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp(\.sha256)?$/;

/**
 * Durable local bytes. A write lands in a temporary file in the same directory,
 * is fsynced, and is renamed over the destination. Readers keep the previous
 * inode if a replace is in progress. A sidecar holds the SHA-256 of the stored bytes.
 */
export class LocalFsBlobStore implements BlobStore {
  readonly kind = "local" as const;
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private full(key: string): string {
    if (!KEY.test(key) || key.includes("..") || key.startsWith("/") || key.endsWith("/")) {
      throw new DriveError(400, "invalid_key", "Storage key is not allowed");
    }
    const full = resolve(this.root, key);
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new DriveError(400, "invalid_key", "Storage key escapes the data directory");
    }
    return full;
  }

  async putStream(key: string, body: Readable): Promise<StoredBlob> {
    const dest = this.full(key);
    const dir = dirname(dest);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${randomUUID()}.tmp`);
    const sumTmp = `${tmp}.sha256`;
    const hash = createHash("sha256");
    let size = 0;
    const tap = new Transform({
      transform(chunk, _enc, cb) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        size += buf.length;
        cb(null, buf);
      },
    });
    try {
      await pipeline(body, tap, createWriteStream(tmp, { flags: "wx", mode: 0o600 }));
      const digest = hash.digest("hex");
      const file = await open(tmp, "r+");
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      await writeFile(sumTmp, `${digest} ${size}\n`, { flag: "wx", mode: 0o600 });
      const sum = await open(sumTmp, "r+");
      try {
        await sum.sync();
      } finally {
        await sum.close();
      }
      await rename(tmp, dest);
      await rename(sumTmp, `${dest}.sha256`);
      // Persist the renames. Windows cannot fsync a directory handle (EPERM) and makes
      // renames durable through NTFS journaling, so the directory sync is POSIX only.
      if (process.platform !== "win32") {
        const dirHandle = await open(dir, "r");
        try {
          await dirHandle.sync();
        } finally {
          await dirHandle.close();
        }
      }
      return { size, sha256: digest };
    } catch (err) {
      await rm(tmp, { force: true });
      await rm(sumTmp, { force: true });
      throw err;
    }
  }

  private async fileStat(key: string) {
    const dest = this.full(key);
    try {
      const st = await lstat(dest);
      if (!st.isFile()) throw new DriveError(500, "invalid_blob", "Stored object is not a regular file");
      return { dest, st };
    } catch (err) {
      if (err instanceof DriveError) throw err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new DriveError(404, "not_found", "Stored bytes are missing");
      throw err;
    }
  }

  async getStream(key: string, range?: BlobRange): Promise<Readable> {
    const { dest, st } = await this.fileStat(key);
    if (range && (range.start < 0 || range.end < range.start || range.start >= st.size)) {
      throw new DriveError(416, "bad_range", "Range is not satisfiable");
    }
    return createReadStream(dest, range ? { start: range.start, end: Math.min(range.end, st.size - 1) } : undefined);
  }

  async verify(key: string): Promise<StoredBlob> {
    const dest = this.full(key);
    const fh = await open(`${dest}.sha256`, "r");
    let side: string;
    try {
      const st = await fh.stat();
      if (!st.isFile() || st.size > 128) throw new DriveError(500, "checksum_mismatch", "Stored checksum is missing");
      side = (await fh.readFile({ encoding: "utf8" })).trim();
    } finally {
      await fh.close();
    }
    const [expect, sizeStr] = side.split(" ");
    const hash = createHash("sha256");
    let size = 0;
    const stream = await this.getStream(key);
    try {
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        size += buf.length;
      }
    } finally {
      stream.destroy();
    }
    const digest = hash.digest("hex");
    if (!expect || digest !== expect || sizeStr !== String(size)) {
      throw new DriveError(500, "checksum_mismatch", "Stored bytes do not match the checksum");
    }
    return { size, sha256: digest };
  }

  async delete(key: string): Promise<void> {
    const dest = this.full(key);
    await rm(dest, { force: true });
    await rm(`${dest}.sha256`, { force: true });
  }

  async size(key: string): Promise<number> {
    return (await this.fileStat(key)).st.size;
  }

  /**
   * Walks the data directory. Yields objects (by key, never their .sha256 sidecar) and putStream's
   * leftover temporary files. Symlinks, other file types and names this driver never generates are
   * skipped, so the sweep can't touch anything it doesn't own.
   */
  async *list(): AsyncIterable<BlobListing> {
    const walk = async function* (this: LocalFsBlobStore, dir: string): AsyncIterable<BlobListing> {
      let handle;
      try {
        handle = await opendir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for await (const entry of handle) {
        const full = join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          yield* walk.call(this, full);
          continue;
        }
        if (!entry.isFile()) continue;
        const rel = relative(this.root, full).split(sep).join("/");
        if (TEMP_NAME.test(entry.name)) {
          yield { kind: "temp", key: rel, modifiedAt: (await lstat(full)).mtime };
          continue;
        }
        if (entry.name.endsWith(".sha256")) continue;
        if (!KEY.test(rel) || rel.includes("..")) continue;
        yield { kind: "object", key: rel, modifiedAt: (await lstat(full)).mtime };
      }
    };
    yield* walk.call(this, this.root);
  }

  async deleteTemp(path: string): Promise<void> {
    const name = path.split("/").pop() ?? "";
    const full = resolve(this.root, path);
    if (!TEMP_NAME.test(name) || !full.startsWith(this.root + sep)) {
      throw new DriveError(400, "invalid_key", "Not a temporary file this store wrote");
    }
    await rm(full, { force: true });
  }
}
