import type { Readable } from "node:stream";
import type { BlobRange, BlobStore, StoredBlob } from "./driver.ts";
import { DriveError } from "./errors.ts";

const DISABLED =
  "S3-compatible storage is not enabled. Cumulus://Cloud stores bytes on the local filesystem. No paid object-storage service is configured.";

/**
 * Interface placeholder for a later S3-compatible driver (AWS SDK for JavaScript v3,
 * Apache-2.0, which also speaks MinIO and R2). This build does not import that SDK,
 * does not read access keys, and does not open a network connection.
 *
 * A future driver would map BlobStore onto CreateMultipartUpload, UploadPart,
 * CompleteMultipartUpload, PutObject, GetObject with Range, and DeleteObject,
 * with forcePathStyle for non-AWS endpoints. It stays off until that work is explicit.
 */
export class S3BlobStore implements BlobStore {
  readonly kind = "s3" as const;

  constructor() {
    this.disabled();
  }

  private disabled(): never {
    throw new DriveError(400, "s3_disabled", DISABLED);
  }

  putStream(_key: string, _body: Readable): Promise<StoredBlob> {
    this.disabled();
  }

  getStream(_key: string, _range?: BlobRange): Promise<Readable> {
    this.disabled();
  }

  verify(_key: string): Promise<StoredBlob> {
    this.disabled();
  }

  delete(_key: string): Promise<void> {
    this.disabled();
  }

  size(_key: string): Promise<number> {
    this.disabled();
  }
}

/** Default is the local filesystem. `s3` is rejected before any credential or endpoint is read. */
export function assertLocalDriver(name: string | undefined): "local" {
  const raw = (name ?? "local").trim().toLowerCase();
  if (raw === "" || raw === "local" || raw === "filesystem") return "local";
  if (raw === "s3" || raw === "s3-compatible") {
    new S3BlobStore();
  }
  throw new DriveError(400, "unknown_driver", `Unknown storage driver "${raw}". Use local.`);
}
