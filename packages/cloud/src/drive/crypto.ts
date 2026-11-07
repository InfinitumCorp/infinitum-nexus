import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { DriveError } from "./errors.ts";

const MAGIC = Buffer.from("CCv1");

/**
 * Master key material is read from the environment variable named by
 * CUMULUS_CLOUD_KMS_KEY_NAME. The name is configuration. The bytes are not
 * hardcoded and are not logged.
 */
export class MasterKey {
  readonly name: string;
  private readonly key: Buffer;

  constructor(name: string, key: Buffer) {
    if (key.length !== 32) throw new DriveError(500, "kms_config", `Environment variable ${name} must be 32 bytes, base64-encoded`);
    this.name = name;
    this.key = key;
  }

  static fromEnv(env: NodeJS.ProcessEnv): MasterKey | null {
    const name = env.CUMULUS_CLOUD_KMS_KEY_NAME?.trim();
    if (!name) return null;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
      throw new DriveError(500, "kms_config", "CUMULUS_CLOUD_KMS_KEY_NAME must be the name of an environment variable");
    }
    const raw = env[name];
    if (!raw) throw new DriveError(500, "kms_config", `Environment variable ${name} is not set`);
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) throw new DriveError(500, "kms_config", `Environment variable ${name} must be 32 bytes, base64-encoded`);
    return new MasterKey(name, key);
  }

  wrap(dek: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
  }

  unwrap(wrapped: string): Buffer {
    const buf = Buffer.from(wrapped, "base64");
    if (buf.length < 12 + 16 + 1) throw new DriveError(500, "key_unwrap", "Wrapped file key is not valid");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(enc), decipher.final()]);
    } catch {
      throw new DriveError(500, "key_unwrap", "Wrapped file key could not be opened");
    }
  }
}

export interface FileKey {
  dek: Buffer;
  salt: Buffer;
  wrapped: string | null;
}

export function newFileKey(master: MasterKey | null): FileKey | null {
  if (!master) return null;
  const dek = randomBytes(32);
  const salt = randomBytes(4);
  return { dek, salt, wrapped: master.wrap(dek) };
}

export function chunkNonce(salt: Buffer, index: number): Buffer {
  if (salt.length !== 4) throw new DriveError(500, "corrupt_blob", "File salt is not valid");
  if (!Number.isSafeInteger(index) || index < 0) throw new DriveError(500, "corrupt_blob", "Chunk index is not valid");
  const nonce = Buffer.alloc(12);
  salt.copy(nonce, 0, 0, 4);
  nonce.writeBigUInt64BE(BigInt(index), 4);
  return nonce;
}

export function encryptChunk(dek: Buffer, salt: Buffer, index: number, plain: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", dek, chunkNonce(salt, index));
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([enc, cipher.getAuthTag()]);
}

export function decryptChunk(dek: Buffer, salt: Buffer, index: number, packed: Buffer): Buffer {
  if (packed.length < 16) throw new DriveError(500, "corrupt_blob", "Encrypted chunk is truncated");
  const tag = packed.subarray(packed.length - 16);
  const enc = packed.subarray(0, packed.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", dek, chunkNonce(salt, index));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch {
    throw new DriveError(500, "corrupt_blob", "Encrypted chunk failed authentication");
  }
}

export function header(chunkSize: number): Buffer {
  if (!Number.isInteger(chunkSize) || chunkSize < 1024 || chunkSize > 8 * 1024 * 1024) {
    throw new DriveError(500, "config", "Chunk size is out of range");
  }
  const h = Buffer.alloc(8);
  MAGIC.copy(h, 0);
  h.writeUInt32BE(chunkSize, 4);
  return h;
}

export function chunkPlainLength(plainSize: number, chunkSize: number, index: number): number {
  const start = index * chunkSize;
  if (start >= plainSize) return 0;
  return Math.min(chunkSize, plainSize - start);
}

/** Byte offset of chunk `index` inside an encrypted blob that starts with the 8-byte header. */
export function cipherOffset(plainSize: number, chunkSize: number, index: number): number {
  let offset = 8;
  for (let i = 0; i < index; i++) offset += chunkPlainLength(plainSize, chunkSize, i) + 16;
  return offset;
}

/** Queues a readable so a consumer can pull an exact number of bytes. */
export class ByteQueue {
  private chunks: Buffer[] = [];
  private length = 0;
  private ended = false;
  private failed: Error | null = null;
  private waiters: (() => void)[] = [];

  push(buf: Buffer) {
    if (buf.length === 0 || this.ended) return;
    this.chunks.push(buf);
    this.length += buf.length;
    this.wake();
  }

  end() {
    this.ended = true;
    this.wake();
  }

  fail(err: Error) {
    this.failed = err;
    this.ended = true;
    this.wake();
  }

  private wake() {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Read exactly n bytes, or a short final buffer when the source has ended. Null means clean EOF. */
  async readChunk(n: number): Promise<Buffer | null> {
    while (this.length < n && !this.ended) {
      if (this.failed) throw this.failed;
      await this.wait();
    }
    if (this.failed) throw this.failed;
    if (this.length === 0 && this.ended) return null;
    return this.takeReady(Math.min(n, this.length));
  }

  async take(n: number): Promise<Buffer> {
    while (this.length < n) {
      if (this.failed) throw this.failed;
      if (this.ended) throw new DriveError(500, "corrupt_blob", "Stored bytes ended before a full chunk");
      await this.wait();
    }
    return this.takeReady(n);
  }

  private takeReady(n: number): Buffer {
    const out = Buffer.alloc(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      if (!head) throw new DriveError(500, "corrupt_blob", "Stored bytes ended before a full chunk");
      const take = Math.min(head.length, n - filled);
      head.copy(out, filled, 0, take);
      filled += take;
      this.length -= take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    return out;
  }
}

export function pump(source: Readable, queue: ByteQueue) {
  void (async () => {
    try {
      for await (const chunk of source) queue.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      queue.end();
    } catch (err) {
      queue.fail(err instanceof Error ? err : new Error("read failed"));
    }
  })();
}

export function encryptPlaintext(source: Readable, dek: Buffer, salt: Buffer, chunkSize: number, chunkStart: number, withHeader: boolean): Readable {
  return Readable.from(generate());

  async function* generate(): AsyncGenerator<Buffer> {
    if (withHeader) yield header(chunkSize);
    const queue = new ByteQueue();
    pump(source, queue);
    let index = chunkStart;
    for (;;) {
      const piece = await queue.readChunk(chunkSize);
      if (!piece || piece.length === 0) return;
      yield encryptChunk(dek, salt, index, piece);
      index += 1;
    }
  }
}

export function decryptPlaintext(source: Readable, dek: Buffer, salt: Buffer, plainSize: number): Readable {
  return Readable.from(generate());

  async function* generate(): AsyncGenerator<Buffer> {
    const queue = new ByteQueue();
    pump(source, queue);
    const head = await queue.take(8);
    const chunkSize = readHeader(head);
    let remaining = plainSize;
    let index = 0;
    while (remaining > 0) {
      const n = Math.min(chunkSize, remaining);
      yield decryptChunk(dek, salt, index, await queue.take(n + 16));
      remaining -= n;
      index += 1;
    }
  }
}

/** Decrypt ciphertext that has no file header (one multipart part). */
export function decryptPart(source: Readable, dek: Buffer, salt: Buffer, plainSize: number, chunkSize: number, chunkStart: number): Readable {
  return Readable.from(generate());

  async function* generate(): AsyncGenerator<Buffer> {
    const queue = new ByteQueue();
    pump(source, queue);
    let remaining = plainSize;
    let index = chunkStart;
    while (remaining > 0) {
      const n = Math.min(chunkSize, remaining);
      yield decryptChunk(dek, salt, index, await queue.take(n + 16));
      remaining -= n;
      index += 1;
    }
  }
}

export function readHeader(head: Buffer): number {
  if (head.length !== 8 || !head.subarray(0, 4).equals(MAGIC)) {
    throw new DriveError(500, "corrupt_blob", "Encrypted blob header is not valid");
  }
  const chunkSize = head.readUInt32BE(4);
  if (chunkSize < 1024 || chunkSize > 8 * 1024 * 1024) throw new DriveError(500, "corrupt_blob", "Encrypted blob chunk size is not valid");
  return chunkSize;
}

export function hashTap(maxBytes: number): { stream: Transform; result: () => { sha256: string; size: number } } {
  const hash = createHash("sha256");
  let size = 0;
  let done: { sha256: string; size: number } | null = null;
  const stream = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        cb(new DriveError(413, "too_large", "Upload exceeds the size limit"));
        return;
      }
      hash.update(buf);
      cb(null, buf);
    },
    flush(cb: TransformCallback) {
      done = { sha256: hash.digest("hex"), size };
      cb();
    },
  });
  return {
    stream,
    result() {
      if (!done) throw new DriveError(500, "checksum", "Checksum was not finished");
      return done;
    },
  };
}

export function capturePrefix(limit: number): { stream: Transform; prefix: () => Buffer } {
  const parts: Buffer[] = [];
  let got = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (got < limit) {
        const take = buf.subarray(0, limit - got);
        parts.push(Buffer.from(take));
        got += take.length;
      }
      cb(null, buf);
    },
  });
  return { stream, prefix: () => (parts.length ? Buffer.concat(parts) : Buffer.alloc(0)) };
}

export async function readAll(source: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of source) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
