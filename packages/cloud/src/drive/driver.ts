import type { Readable } from "node:stream";

export interface BlobRange {
  /** Inclusive start, matching Node's file streams and HTTP Range. */
  start: number;
  /** Inclusive end. */
  end: number;
}

export interface StoredBlob {
  size: number;
  sha256: string;
}

/** One entry from BlobStore.list(). */
export interface BlobListing {
  /** "object": a stored blob, addressed by `key`. "temp": a leftover half-written file, addressed by `path`. */
  kind: "object" | "temp";
  /** Object key (kind "object") or path relative to the store root (kind "temp"). */
  key: string;
  modifiedAt: Date;
}

/**
 * Byte store. The local filesystem driver is the one this build runs.
 * An S3-compatible driver would implement the same methods; it is stubbed and off.
 */
export interface BlobStore {
  readonly kind: "local" | "s3";
  putStream(key: string, body: Readable): Promise<StoredBlob>;
  getStream(key: string, range?: BlobRange): Promise<Readable>;
  /** Re-hash the stored bytes and compare them to the sidecar written with the object. */
  verify(key: string): Promise<StoredBlob>;
  delete(key: string): Promise<void>;
  size(key: string): Promise<number>;
  /**
   * Every stored object and leftover temporary file, for the orphan sweep. Optional: a driver that
   * can't list is never swept. Must never yield anything it didn't write (unknown files are skipped).
   */
  list?(): AsyncIterable<BlobListing>;
  /** Remove a leftover temporary file yielded by list(). */
  deleteTemp?(path: string): Promise<void>;
}
