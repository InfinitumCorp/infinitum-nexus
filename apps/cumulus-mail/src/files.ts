import { randomUUID } from "node:crypto";

/**
 * Where attachment contents live. Messages only carry a file's key, name, size and type; the
 * bytes are here: Cloudflare R2 on Workers, memory in tests and local runs.
 *
 * Keys: `u/{cid}/{uuid}` for files a person uploaded, `in/{uuid}` for files that arrived on
 * mail from outside Cumulus. UUIDs make keys unguessable; downloads are still checked against
 * the signed-in person's mailbox.
 */
export interface FileStore {
  put(key: string, data: Uint8Array, type: string): Promise<void>;
  get(key: string): Promise<{ data: Uint8Array; type: string } | null>;
  /** Removes a stored file (Drive's permanent delete). Missing keys are fine. */
  delete?(key: string): Promise<void>;
}

/** Largest single file, matching the composer and Email Sending's 25 MiB message limit. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export const uploadKey = (cid: string) => `u/${cid}/${randomUUID()}`;
export const inboundKey = () => `in/${randomUUID()}`;
export const isFileKey = (key: string) => /^(u\/[A-Za-z0-9_-]{1,80}|in)\/[0-9a-f-]{36}$/.test(key);

/** A content type safe to store and serve back: plain `type/subtype`, else octet-stream. */
export function safeType(type: string | null | undefined): string {
  const t = String(type ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/.test(t) ? t : "application/octet-stream";
}

export class MemoryFileStore implements FileStore {
  readonly files = new Map<string, { data: Uint8Array; type: string }>();
  async put(key: string, data: Uint8Array, type: string) {
    this.files.set(key, { data: new Uint8Array(data), type });
  }
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}

/** The parts of a Workers R2 bucket binding that Cumulus uses. */
export interface R2BucketLike {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete?(key: string): Promise<void>;
}

export function r2FileStore(bucket: R2BucketLike): FileStore {
  return {
    async put(key, data, type) {
      await bucket.put(key, data, { httpMetadata: { contentType: type } });
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return { data: new Uint8Array(await obj.arrayBuffer()), type: obj.httpMetadata?.contentType ?? "application/octet-stream" };
    },
    async delete(key) {
      await bucket.delete?.(key);
    },
  };
}
