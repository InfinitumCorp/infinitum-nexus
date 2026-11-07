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
}
