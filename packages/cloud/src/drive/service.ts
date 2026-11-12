import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FREE_STORAGE_GB, GB } from "../quota.ts";
import {
  ByteQueue,
  MasterKey,
  capturePrefix,
  chunkPlainLength,
  cipherOffset,
  decryptChunk,
  decryptPart,
  decryptPlaintext,
  encryptPlaintext,
  hashTap,
  header,
  newFileKey,
  pump,
  readAll,
  readHeader,
  sha256,
  type FileKey,
} from "./crypto.ts";
import type { BlobStore } from "./driver.ts";
import { DriveError } from "./errors.ts";
import { DriveRepo, type FileRecord, type PartRecord } from "./repo.ts";
import { sniff } from "./sniff.ts";

export interface FileInfo {
  id: string;
  name: string;
  folderId: string | null;
  size: number;
  sha256: string;
  mediaType: string;
  encrypted: boolean;
  versionId: string;
  version: number;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FolderInfo {
  id: string;
  name: string;
  parentId: string | null;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VersionInfo {
  id: string;
  version: number;
  size: number;
  sha256: string;
  mediaType: string;
  encrypted: boolean;
  createdAt: string;
  current: boolean;
}

export interface UploadInfo {
  id: string;
  name: string;
  folderId: string | null;
  fileId: string | null;
  declaredSize: number;
  bytesReceived: number;
  partSize: number;
  expiresAt: string;
  parts: { partNumber: number; size: number; sha256: string }[];
}

export interface ShareInfo {
  id: string;
  fileId: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  token?: string;
}

export interface Download {
  info: FileInfo;
  stream: Readable;
  start: number;
  end: number;
  total: number;
}

/** What sweepOrphanBlobs found (and, unless dryRun, removed). */
export interface OrphanSweep {
  dryRun: boolean;
  /** Objects old enough to check. */
  scanned: number;
  /** Object keys nothing in the database points at. */
  orphans: string[];
  /** Leftover temporary files from interrupted writes. */
  temps: string[];
  /** Objects plus temporary files actually removed (0 on a dry run). */
  deleted: number;
}

export interface DriveServiceOptions {
  repo: DriveRepo;
  blobs: BlobStore;
  master?: MasterKey | null;
  maxUploadBytes?: number;
  chunkSize?: number;
  partSize?: number;
  quotaBytes?: (ownerCid: string) => number;
  clock?: () => Date;
  uploadTtlMs?: number;
}

const DEFAULT_CHUNK = 64 * 1024;
const DEFAULT_PART = 8 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Cumulus://Cloud Drive. The signed-in CID is the only owner. Byte writes are
 * checksummed, quota is reserved before the bytes are kept, and trash keeps
 * using quota until a purge.
 */
export class DriveService {
  readonly repo: DriveRepo;
  readonly blobs: BlobStore;
  readonly driverKind: BlobStore["kind"];
  private readonly master: MasterKey | null;
  readonly maxUploadBytes: number;
  readonly chunkSize: number;
  readonly partSize: number;
  private readonly quotaBytes: (ownerCid: string) => number;
  private readonly clock: () => Date;
  private readonly uploadTtlMs: number;

  constructor(opts: DriveServiceOptions) {
    this.repo = opts.repo;
    this.blobs = opts.blobs;
    this.driverKind = opts.blobs.kind;
    this.master = opts.master ?? null;
    this.maxUploadBytes = opts.maxUploadBytes ?? 5 * 1024 * 1024 * 1024;
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
    this.partSize = opts.partSize ?? DEFAULT_PART;
    this.quotaBytes = opts.quotaBytes ?? (() => FREE_STORAGE_GB * GB);
    this.clock = opts.clock ?? (() => new Date());
    this.uploadTtlMs = opts.uploadTtlMs ?? DAY_MS;
    if (this.partSize % this.chunkSize !== 0) {
      throw new DriveError(500, "config", "Part size must be a multiple of the encryption chunk size");
    }
  }

  async quota(ownerCid: string) {
    const usage = await this.repo.usage(ownerCid, this.quotaBytes(ownerCid));
    return { ...usage, label: `${usage.usedBytes} of ${usage.limitBytes} bytes` };
  }

  async list(ownerCid: string, folderId: string | null, opts: { cursorFolder?: string | null; cursorFile?: string | null; limit?: number } = {}) {
    await this.requireLiveFolder(ownerCid, folderId);
    const limit = this.pageLimit(opts.limit);
    const [folders, files] = await Promise.all([
      this.repo.listFolders(ownerCid, folderId, opts.cursorFolder ?? null, limit),
      this.repo.listFiles(ownerCid, folderId, opts.cursorFile ?? null, limit),
    ]);
    return {
      folders: folders.map(folderInfo),
      files: files.map(fileInfo),
      nextFolder: folders.length === limit ? folders[folders.length - 1]?.name ?? null : null,
      nextFile: files.length === limit ? files[files.length - 1]?.name ?? null : null,
    };
  }

  async trash(ownerCid: string) {
    const [folders, files] = await Promise.all([this.repo.listTrashedFolders(ownerCid), this.repo.listTrashedFiles(ownerCid)]);
    return { folders: folders.map(folderInfo), files: files.map(fileInfo) };
  }

  async createFolder(ownerCid: string, name: string, parentId: string | null): Promise<FolderInfo> {
    await this.requireLiveFolder(ownerCid, parentId);
    return folderInfo(await this.repo.createFolder(ownerCid, parentId, name));
  }

  async updateFolder(ownerCid: string, id: string, patch: { name?: string; parentId?: string | null }): Promise<FolderInfo> {
    if (patch.parentId) await this.requireLiveFolder(ownerCid, patch.parentId);
    const folder = await this.repo.updateFolder(ownerCid, id, patch);
    if (!folder) throw new DriveError(404, "not_found", "No such folder");
    return folderInfo(folder);
  }

  async trashFolder(ownerCid: string, id: string): Promise<void> {
    if (!(await this.repo.trashFolder(ownerCid, id))) throw new DriveError(404, "not_found", "No such folder");
  }

  async restoreFolder(ownerCid: string, id: string): Promise<FolderInfo> {
    const folder = await this.repo.restoreFolder(ownerCid, id);
    if (!folder) throw new DriveError(404, "not_found", "No such folder");
    return folderInfo(folder);
  }

  async purgeFolder(ownerCid: string, id: string): Promise<void> {
    const purged = await this.repo.purgeFolder(ownerCid, id);
    if (!purged) throw new DriveError(404, "not_found", "No such folder");
    for (const key of purged.keys) await this.blobs.delete(key);
  }

  async emptyTrash(ownerCid: string): Promise<{ files: number; folders: number }> {
    const folders = await this.repo.listTrashedFolders(ownerCid);
    const top = folders.filter((folder) => !folder.parentId || !folders.some((parent) => parent.id === folder.parentId));
    for (const folder of top) await this.purgeFolder(ownerCid, folder.id);
    const files = await this.repo.listTrashedFiles(ownerCid);
    for (const file of files) await this.purgeFile(ownerCid, file.id);
    return { folders: top.length, files: files.length };
  }

  async upload(
    ownerCid: string,
    source: Readable,
    opts: { name: string; folderId: string | null; declaredSize: number; declaredType: string; expectedSha256: string | null },
  ): Promise<FileInfo> {
    this.assertSize(opts.declaredSize);
    await this.requireLiveFolder(ownerCid, opts.folderId);
    const fileKey = newFileKey(this.master);
    const storageKey = objectKey(ownerCid);
    await this.repo.reserve(ownerCid, opts.declaredSize, this.quotaBytes(ownerCid));
    try {
      const written = await this.writeBytes(source, storageKey, modeOf(fileKey, 0, true), opts.declaredSize);
      if (written.plainSize !== opts.declaredSize) {
        throw new DriveError(400, "incomplete_upload", "Upload ended before Content-Length bytes were received");
      }
      this.assertChecksum(opts.expectedSha256, written.plainSha256);
      const media = sniff(written.prefix, opts.declaredType);
      const file = await this.repo.insertFile(ownerCid, opts.folderId, opts.name, {
        sizeBytes: written.plainSize,
        sha256: written.plainSha256,
        blobSha256: written.blobSha256,
        declaredType: opts.declaredType,
        mediaType: media.mediaType,
        storageKey,
        encrypted: fileKey !== null,
        wrappedDek: fileKey?.wrapped ?? null,
        contentSalt: fileKey ? fileKey.salt.toString("base64") : null,
      });
      return fileInfo(file);
    } catch (err) {
      await this.discard(ownerCid, opts.declaredSize, storageKey);
      throw err;
    }
  }

  async uploadVersion(
    ownerCid: string,
    fileId: string,
    source: Readable,
    opts: { declaredSize: number; declaredType: string; expectedSha256: string | null },
  ): Promise<FileInfo> {
    this.assertSize(opts.declaredSize);
    const existing = await this.visibleFile(ownerCid, fileId);
    const fileKey = newFileKey(this.master);
    const storageKey = objectKey(ownerCid);
    await this.repo.reserve(ownerCid, opts.declaredSize, this.quotaBytes(ownerCid));
    try {
      const written = await this.writeBytes(source, storageKey, modeOf(fileKey, 0, true), opts.declaredSize);
      if (written.plainSize !== opts.declaredSize) {
        throw new DriveError(400, "incomplete_upload", "Upload ended before Content-Length bytes were received");
      }
      this.assertChecksum(opts.expectedSha256, written.plainSha256);
      const media = sniff(written.prefix, opts.declaredType);
      return fileInfo(
        await this.repo.addVersion(ownerCid, existing.id, {
          sizeBytes: written.plainSize,
          sha256: written.plainSha256,
          blobSha256: written.blobSha256,
          declaredType: opts.declaredType,
          mediaType: media.mediaType,
          storageKey,
          encrypted: fileKey !== null,
          wrappedDek: fileKey?.wrapped ?? null,
          contentSalt: fileKey ? fileKey.salt.toString("base64") : null,
        }),
      );
    } catch (err) {
      await this.discard(ownerCid, opts.declaredSize, storageKey);
      throw err;
    }
  }

  async getFile(ownerCid: string, id: string): Promise<FileInfo> {
    return fileInfo(await this.visibleFile(ownerCid, id));
  }

  async download(ownerCid: string, id: string, range: { start: number; end: number } | null): Promise<Download> {
    const file = await this.visibleFile(ownerCid, id);
    return this.openDownload(file, range);
  }

  async verifyFile(ownerCid: string, id: string): Promise<{ sha256: string; size: number }> {
    const file = await this.visibleFile(ownerCid, id);
    await this.blobs.verify(file.storageKey);
    const download = await this.openDownload(file, null);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of download.stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      size += buf.length;
    }
    const digest = hash.digest("hex");
    if (digest !== file.sha256 || size !== file.size) {
      throw new DriveError(409, "checksum_mismatch", "Stored bytes do not match the recorded SHA-256");
    }
    return { sha256: digest, size };
  }

  async updateFile(ownerCid: string, id: string, patch: { name?: string; folderId?: string | null }): Promise<FileInfo> {
    await this.visibleFile(ownerCid, id);
    if (patch.folderId) await this.requireLiveFolder(ownerCid, patch.folderId);
    const file = await this.repo.updateFile(ownerCid, id, patch);
    if (!file) throw new DriveError(404, "not_found", "No such file");
    return fileInfo(file);
  }

  async trashFile(ownerCid: string, id: string): Promise<void> {
    if (!(await this.repo.trashFile(ownerCid, id))) throw new DriveError(404, "not_found", "No such file");
  }

  async restoreFile(ownerCid: string, id: string): Promise<FileInfo> {
    const file = await this.repo.restoreFile(ownerCid, id);
    if (!file) throw new DriveError(404, "not_found", "No such file");
    return fileInfo(file);
  }

  async purgeFile(ownerCid: string, id: string): Promise<void> {
    const purged = await this.repo.purgeFile(ownerCid, id);
    if (!purged) throw new DriveError(404, "not_found", "No such file");
    for (const key of purged.keys) await this.blobs.delete(key);
  }

  async versions(ownerCid: string, fileId: string): Promise<VersionInfo[]> {
    await this.visibleFile(ownerCid, fileId);
    const rows = await this.repo.listVersions(ownerCid, fileId);
    if (!rows) throw new DriveError(404, "not_found", "No such file");
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      size: row.size,
      sha256: row.sha256,
      mediaType: row.mediaType,
      encrypted: row.encrypted,
      createdAt: row.createdAt,
      current: row.current,
    }));
  }

  async deleteVersion(ownerCid: string, fileId: string, versionId: string): Promise<void> {
    await this.visibleFile(ownerCid, fileId);
    const deleted = await this.repo.deleteVersion(ownerCid, fileId, versionId);
    if (!deleted) throw new DriveError(404, "not_found", "No such version");
    await this.blobs.delete(deleted.storageKey);
  }

  async startUpload(
    ownerCid: string,
    opts: { name: string; folderId: string | null; fileId: string | null; declaredSize: number; declaredType: string; expectedSha256: string | null },
  ): Promise<UploadInfo> {
    this.assertSize(opts.declaredSize);
    if (opts.fileId) await this.visibleFile(ownerCid, opts.fileId);
    else await this.requireLiveFolder(ownerCid, opts.folderId);
    const fileKey = newFileKey(this.master);
    await this.repo.reserve(ownerCid, opts.declaredSize, this.quotaBytes(ownerCid));
    try {
      const upload = await this.repo.createUpload({
        ownerCid,
        folderId: opts.fileId ? null : opts.folderId,
        fileId: opts.fileId,
        name: opts.name,
        declaredSize: opts.declaredSize,
        declaredType: opts.declaredType,
        expectedSha256: opts.expectedSha256,
        partSize: this.partSize,
        encrypted: fileKey !== null,
        wrappedDek: fileKey?.wrapped ?? null,
        contentSalt: fileKey ? fileKey.salt.toString("base64") : null,
        expiresAt: new Date(this.clock().getTime() + this.uploadTtlMs).toISOString(),
      });
      return this.uploadInfo(ownerCid, upload.id);
    } catch (err) {
      await this.repo.release(ownerCid, opts.declaredSize);
      throw err;
    }
  }

  async uploadStatus(ownerCid: string, id: string): Promise<UploadInfo> {
    return this.uploadInfo(ownerCid, id);
  }

  async putPart(ownerCid: string, uploadId: string, partNumber: number, source: Readable, size: number): Promise<{ partNumber: number; size: number; sha256: string }> {
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
      throw new DriveError(400, "bad_part", "Part numbers run from 1 to 10000");
    }
    const upload = await this.requireOpenUpload(ownerCid, uploadId);
    if (size < 0 || size > upload.partSize || (upload.declaredSize > 0 && size === 0)) {
      throw new DriveError(400, "bad_size", "Part size is not valid");
    }
    await this.repo.assertPartFits(ownerCid, uploadId, partNumber, size, this.clock());
    const storageKey = partKey(uploadId, partNumber);
    const fileKey = upload.encrypted ? this.keyFromUpload(upload.wrappedDek, upload.contentSalt) : null;
    const chunkStart = (partNumber - 1) * (this.partSize / this.chunkSize);
    const written = await this.writeBytes(source, storageKey, modeOf(fileKey, chunkStart, false), size);
    if (written.plainSize !== size) {
      await this.blobs.delete(storageKey);
      throw new DriveError(400, "incomplete_upload", "Part ended before Content-Length bytes were received");
    }
    await this.repo.savePart(ownerCid, uploadId, { partNumber, size: written.plainSize, sha256: written.plainSha256, storageKey });
    return { partNumber, size: written.plainSize, sha256: written.plainSha256 };
  }

  async completeUpload(ownerCid: string, uploadId: string): Promise<FileInfo> {
    const upload = await this.requireOpenUpload(ownerCid, uploadId);
    const parts = await this.repo.parts(ownerCid, uploadId);
    this.checkParts(parts, upload.declaredSize);
    for (const part of parts) {
      const verified = await this.blobs.verify(part.storageKey);
      if (upload.encrypted) {
        const fileKey = this.keyFromUpload(upload.wrappedDek, upload.contentSalt);
        const chunkStart = (part.partNumber - 1) * (this.partSize / this.chunkSize);
        const plain = decryptPart(await this.blobs.getStream(part.storageKey), fileKey.dek, fileKey.salt, part.size, this.chunkSize, chunkStart);
        const body = await readAll(plain);
        if (body.length !== part.size || sha256(body) !== part.sha256) {
          throw new DriveError(409, "checksum_mismatch", "A part does not match its checksum");
        }
      } else if (verified.sha256 !== part.sha256 || verified.size !== part.size) {
        throw new DriveError(409, "checksum_mismatch", "A part does not match its checksum");
      }
    }
    const storageKey = objectKey(ownerCid);
    const assembled = await this.assemble(upload, parts, storageKey);
    this.assertChecksum(upload.expectedSha256, assembled.sha256);
    if (assembled.size !== upload.declaredSize) {
      await this.blobs.delete(storageKey);
      throw new DriveError(400, "incomplete_upload", "Uploaded bytes do not match the declared size");
    }
    const version = {
      sizeBytes: assembled.size,
      sha256: assembled.sha256,
      blobSha256: assembled.blobSha256,
      declaredType: upload.declaredType,
      mediaType: assembled.mediaType,
      storageKey,
      encrypted: upload.encrypted,
      wrappedDek: upload.wrappedDek,
      contentSalt: upload.contentSalt,
    };
    let file: FileRecord;
    try {
      file = upload.fileId
        ? await this.repo.addVersion(ownerCid, upload.fileId, version)
        : await this.repo.insertFile(ownerCid, upload.folderId, upload.name, version);
    } catch (err) {
      await this.blobs.delete(storageKey);
      throw err;
    }
    const finished = await this.repo.finishUpload(ownerCid, uploadId, "completed");
    if (!finished) throw new DriveError(409, "conflict", "This upload is already finished");
    for (const part of parts) await this.blobs.delete(part.storageKey);
    return fileInfo(file);
  }

  async abortUpload(ownerCid: string, uploadId: string): Promise<void> {
    const upload = await this.repo.getUpload(ownerCid, uploadId);
    if (!upload || upload.status !== "open") throw new DriveError(404, "not_found", "No such upload");
    await this.releaseUpload(upload.ownerCid, upload.id, upload.declaredSize);
  }

  /**
   * Remove bytes no file version or open upload points at: what a crash between writing the blob and
   * committing the database leaves behind, plus putStream's leftover temporary files.
   *
   * Safe by construction: only objects older than `graceMs` are considered (a write in flight is
   * always younger), each batch is checked against the database right before anything is deleted,
   * and the driver lists only names it generated. `dryRun` (the default) reports without deleting.
   */
  async sweepOrphanBlobs(opts: { graceMs?: number; dryRun?: boolean; batchSize?: number } = {}): Promise<OrphanSweep> {
    const graceMs = opts.graceMs ?? DAY_MS;
    if (!Number.isFinite(graceMs) || graceMs < 60 * 60 * 1000) throw new DriveError(400, "grace_too_short", "The orphan sweep needs a grace period of at least one hour");
    const dryRun = opts.dryRun ?? true;
    const batchSize = Math.max(1, Math.min(opts.batchSize ?? 500, 5000));
    if (!this.blobs.list) throw new DriveError(400, "sweep_unsupported", `The ${this.blobs.kind} driver can't list its objects`);
    const cutoff = this.clock().getTime() - graceMs;
    const result: OrphanSweep = { dryRun, scanned: 0, orphans: [], temps: [], deleted: 0 };

    const flush = async (batch: string[]) => {
      if (!batch.length) return;
      const live = await this.repo.referencedStorageKeys(batch);
      for (const key of batch) {
        if (live.has(key)) continue;
        result.orphans.push(key);
        if (!dryRun) {
          await this.blobs.delete(key);
          result.deleted++;
        }
      }
    };

    let batch: string[] = [];
    for await (const item of this.blobs.list()) {
      if (item.modifiedAt.getTime() > cutoff) continue;
      if (item.kind === "temp") {
        result.temps.push(item.key);
        if (!dryRun && this.blobs.deleteTemp) {
          await this.blobs.deleteTemp(item.key);
          result.deleted++;
        }
        continue;
      }
      result.scanned++;
      batch.push(item.key);
      if (batch.length >= batchSize) {
        await flush(batch);
        batch = [];
      }
    }
    await flush(batch);
    return result;
  }

  async expireUploads(): Promise<number> {
    const expired = await this.repo.expiredUploads(this.clock());
    for (const upload of expired) await this.releaseUpload(upload.ownerCid, upload.id, upload.declaredSize);
    return expired.length;
  }

  async createShare(ownerCid: string, fileId: string, expiresAt: unknown): Promise<ShareInfo> {
    await this.visibleFile(ownerCid, fileId);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const share = await this.repo.createShare(ownerCid, fileId, tokenHash, this.parseExpiry(expiresAt));
    return { ...shareInfo(share), token };
  }

  async listShares(ownerCid: string, fileId: string): Promise<ShareInfo[]> {
    await this.visibleFile(ownerCid, fileId);
    const shares = await this.repo.listShares(ownerCid, fileId);
    if (!shares) throw new DriveError(404, "not_found", "No such file");
    return shares.map(shareInfo);
  }

  async revokeShare(ownerCid: string, shareId: string): Promise<void> {
    if (!(await this.repo.revokeShare(ownerCid, shareId))) throw new DriveError(404, "not_found", "No such share");
  }

  async openShare(token: string, range: { start: number; end: number } | null): Promise<Download> {
    return this.openDownload(await this.shareFile(token), range);
  }

  private async shareFile(token: string): Promise<FileRecord> {
    if (token.length < 20 || token.length > 200) throw new DriveError(404, "not_found", "No such share");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const found = await this.repo.shareByToken(tokenHash, this.clock());
    if (!found) throw new DriveError(404, "not_found", "No such share");
    return found.file;
  }

  async shareInfo(token: string): Promise<Pick<FileInfo, "name" | "size" | "mediaType" | "sha256">> {
    const found = await this.shareFile(token);
    return { name: found.name, size: found.size, mediaType: found.mediaType, sha256: found.sha256 };
  }

  private async openDownload(file: FileRecord, range: { start: number; end: number } | null): Promise<Download> {
    const bounds = resolveRange(range, file.size);
    return { info: fileInfo(file), stream: await this.openBody(file, bounds), start: bounds.start, end: bounds.end, total: file.size };
  }

  private async openBody(file: FileRecord, bounds: { start: number; end: number }): Promise<Readable> {
    if (file.size === 0) return Readable.from([]);
    const key = this.fileKey(file);
    if (!key) {
      const full = bounds.start === 0 && bounds.end === file.size - 1;
      return this.blobs.getStream(file.storageKey, full ? undefined : { start: bounds.start, end: bounds.end });
    }
    const head = await readAll(await this.blobs.getStream(file.storageKey, { start: 0, end: 7 }));
    const chunkSize = readHeader(head);
    if (bounds.start === 0 && bounds.end === file.size - 1) {
      return decryptPlaintext(await this.blobs.getStream(file.storageKey), key.dek, key.salt, file.size);
    }
    const first = Math.floor(bounds.start / chunkSize);
    const last = Math.floor(bounds.end / chunkSize);
    const cipherStart = cipherOffset(file.size, chunkSize, first);
    const lastLen = chunkPlainLength(file.size, chunkSize, last);
    const cipherEnd = cipherOffset(file.size, chunkSize, last) + lastLen + 16 - 1;
    const raw = await this.blobs.getStream(file.storageKey, { start: cipherStart, end: cipherEnd });
    const dek = key.dek;
    const salt = key.salt;
    const plainSize = file.size;
    const start = bounds.start;
    const end = bounds.end;
    return Readable.from(
      (async function* () {
        const queue = new ByteQueue();
        pump(raw, queue);
        let skip = start - first * chunkSize;
        let need = end - start + 1;
        for (let index = first; index <= last && need > 0; index++) {
          const n = chunkPlainLength(plainSize, chunkSize, index);
          let slice: Buffer = decryptChunk(dek, salt, index, await queue.take(n + 16));
          if (skip) {
            slice = slice.subarray(Math.min(skip, slice.length));
            skip = 0;
          }
          if (slice.length > need) slice = slice.subarray(0, need);
          need -= slice.length;
          if (slice.length) yield slice;
        }
      })(),
    );
  }

  private async assemble(
    upload: { encrypted: boolean; wrappedDek: string | null; contentSalt: string | null; declaredType: string; declaredSize: number },
    parts: PartRecord[],
    storageKey: string,
  ): Promise<{ sha256: string; size: number; blobSha256: string; mediaType: string }> {
    if (!upload.encrypted) {
      const written = await this.writeBytes(this.concat(parts), storageKey, null, upload.declaredSize);
      return { sha256: written.plainSha256, size: written.plainSize, blobSha256: written.blobSha256, mediaType: sniff(written.prefix, upload.declaredType).mediaType };
    }
    const fileKey = this.keyFromUpload(upload.wrappedDek, upload.contentSalt);
    const hash = createHash("sha256");
    const prefix: Buffer[] = [];
    let prefixLen = 0;
    let size = 0;
    for (const part of parts) {
      const chunkStart = (part.partNumber - 1) * (this.partSize / this.chunkSize);
      const plain = decryptPart(await this.blobs.getStream(part.storageKey), fileKey.dek, fileKey.salt, part.size, this.chunkSize, chunkStart);
      for await (const chunk of plain) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buf);
        size += buf.length;
        if (prefixLen < 512) {
          const take = buf.subarray(0, 512 - prefixLen);
          prefix.push(Buffer.from(take));
          prefixLen += take.length;
        }
      }
    }
    const digest = hash.digest("hex");
    const bytes = this.blobs;
    const chunkSize = this.chunkSize;
    const body = Readable.from(
      (async function* () {
        yield header(chunkSize);
        for (const part of parts) {
          const stream = await bytes.getStream(part.storageKey);
          for await (const chunk of stream) yield chunk;
        }
      })(),
    );
    const stored = await this.blobs.putStream(storageKey, body);
    const verified = await this.blobs.verify(storageKey);
    if (verified.sha256 !== stored.sha256) throw new DriveError(500, "checksum_mismatch", "Stored checksum does not match the bytes just written");
    return {
      sha256: digest,
      size,
      blobSha256: stored.sha256,
      mediaType: sniff(prefix.length ? Buffer.concat(prefix) : Buffer.alloc(0), upload.declaredType).mediaType,
    };
  }

  private concat(parts: PartRecord[]): Readable {
    const blobs = this.blobs;
    return Readable.from(
      (async function* () {
        for (const part of parts) {
          const stream = await blobs.getStream(part.storageKey);
          for await (const chunk of stream) yield chunk;
        }
      })(),
    );
  }

  private async writeBytes(
    source: Readable,
    key: string,
    mode: { dek: Buffer; salt: Buffer; chunkStart: number; header: boolean } | null,
    maxBytes: number,
  ): Promise<{ plainSha256: string; plainSize: number; prefix: Buffer; blobSha256: string }> {
    const cap = capturePrefix(512);
    const hashed = hashTap(maxBytes);
    const destination = mode ? encryptPlaintext(hashed.stream, mode.dek, mode.salt, this.chunkSize, mode.chunkStart, mode.header) : hashed.stream;
    const piped = pipeline(source, cap.stream, hashed.stream);
    const stored = this.blobs.putStream(key, destination);
    piped.catch(() => undefined);
    stored.catch(() => undefined);
    try {
      const blob = await stored;
      await piped;
      const dig = hashed.result();
      const verified = await this.blobs.verify(key);
      if (verified.sha256 !== blob.sha256 || verified.size !== blob.size) {
        throw new DriveError(500, "checksum_mismatch", "Stored checksum does not match the bytes just written");
      }
      return { plainSha256: dig.sha256, plainSize: dig.size, prefix: cap.prefix(), blobSha256: blob.sha256 };
    } catch (err) {
      source.destroy();
      await this.blobs.delete(key);
      throw err;
    }
  }

  private async discard(ownerCid: string, bytes: number, key: string) {
    await this.repo.release(ownerCid, bytes);
    await this.blobs.delete(key);
  }

  private async releaseUpload(ownerCid: string, uploadId: string, declaredSize: number) {
    const parts = await this.repo.parts(ownerCid, uploadId);
    const finished = await this.repo.finishUpload(ownerCid, uploadId, "aborted");
    if (!finished) return;
    await this.repo.release(ownerCid, declaredSize);
    for (const part of parts) await this.blobs.delete(part.storageKey);
  }

  private async uploadInfo(ownerCid: string, id: string): Promise<UploadInfo> {
    const upload = await this.repo.getUpload(ownerCid, id);
    if (!upload || upload.status !== "open") throw new DriveError(404, "not_found", "No such upload");
    const parts = await this.repo.parts(ownerCid, id);
    return {
      id: upload.id,
      name: upload.name,
      folderId: upload.folderId,
      fileId: upload.fileId,
      declaredSize: upload.declaredSize,
      bytesReceived: upload.bytesReceived,
      partSize: upload.partSize,
      expiresAt: upload.expiresAt,
      parts: parts.map((part) => ({ partNumber: part.partNumber, size: part.size, sha256: part.sha256 })),
    };
  }

  private async requireOpenUpload(ownerCid: string, id: string) {
    const upload = await this.repo.getUpload(ownerCid, id);
    if (!upload || upload.status !== "open") throw new DriveError(404, "not_found", "No such upload");
    if (new Date(upload.expiresAt).getTime() <= this.clock().getTime()) {
      await this.releaseUpload(ownerCid, id, upload.declaredSize);
      throw new DriveError(410, "upload_expired", "This upload has expired");
    }
    return upload;
  }

  private checkParts(parts: PartRecord[], declared: number) {
    if (declared === 0) {
      if (parts.length > 0) throw new DriveError(400, "incomplete_upload", "This upload has unexpected parts");
      return;
    }
    if (parts.length === 0) throw new DriveError(400, "incomplete_upload", "Upload has no parts");
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]?.partNumber !== i + 1) throw new DriveError(400, "incomplete_upload", "Upload is missing a part");
    }
    const sum = parts.reduce((total, part) => total + part.size, 0);
    if (sum !== declared) throw new DriveError(400, "incomplete_upload", "Uploaded bytes do not match the declared size");
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i]?.size !== this.partSize) throw new DriveError(400, "incomplete_upload", "Only the last part can be shorter than the part size");
    }
    const last = parts[parts.length - 1];
    if (!last || last.size <= 0 || last.size > this.partSize) throw new DriveError(400, "bad_size", "The last part is empty");
  }

  private async visibleFile(ownerCid: string, id: string): Promise<FileRecord> {
    const file = await this.repo.getFile(ownerCid, id);
    if (!file || file.trashedAt || (await this.repo.folderBlocked(ownerCid, file.folderId))) {
      throw new DriveError(404, "not_found", "No such file");
    }
    return file;
  }

  private async requireLiveFolder(ownerCid: string, folderId: string | null) {
    if (!folderId) return;
    const folder = await this.repo.getFolder(ownerCid, folderId);
    if (!folder || folder.trashedAt || (await this.repo.folderBlocked(ownerCid, folder.parentId))) {
      throw new DriveError(404, "not_found", "No such folder");
    }
  }

  private assertSize(size: number) {
    if (!Number.isSafeInteger(size) || size < 0) throw new DriveError(400, "bad_size", "Size is not a valid byte count");
    if (size > this.maxUploadBytes) throw new DriveError(413, "too_large", "Upload exceeds the size limit");
  }

  private assertChecksum(expected: string | null, actual: string) {
    if (expected && expected !== actual) throw new DriveError(400, "checksum_mismatch", "SHA-256 does not match the uploaded bytes");
  }

  private pageLimit(limit: number | undefined): number {
    if (limit === undefined) return 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new DriveError(400, "bad_limit", "Limit must be from 1 to 500");
    return limit;
  }

  private parseExpiry(input: unknown): string | null {
    if (input === undefined || input === null || input === "") return null;
    const date = new Date(String(input));
    if (Number.isNaN(date.getTime())) throw new DriveError(400, "bad_expiry", "Expiry is not a valid time");
    const now = this.clock().getTime();
    if (date.getTime() <= now) throw new DriveError(400, "bad_expiry", "Expiry must be in the future");
    if (date.getTime() > now + 10 * 365 * DAY_MS) throw new DriveError(400, "bad_expiry", "Expiry is too far in the future");
    return date.toISOString();
  }

  private fileKey(file: FileRecord): FileKey | null {
    if (!file.encrypted) return null;
    return this.keyFromUpload(file.wrappedDek, file.contentSalt);
  }

  private keyFromUpload(wrappedDek: string | null, contentSalt: string | null): FileKey {
    if (!this.master || !wrappedDek || !contentSalt) {
      throw new DriveError(500, "kms_config", "This file is encrypted and the master key is not available");
    }
    const salt = Buffer.from(contentSalt, "base64");
    if (salt.length !== 4) throw new DriveError(500, "corrupt_blob", "File salt is not valid");
    return { dek: this.master.unwrap(wrappedDek), salt, wrapped: wrappedDek };
  }
}

function modeOf(key: FileKey | null, chunkStart: number, withHeader: boolean) {
  if (!key) return null;
  return { dek: key.dek, salt: key.salt, chunkStart, header: withHeader };
}

function objectKey(ownerCid: string): string {
  const shard = createHash("sha256").update(ownerCid).digest("hex").slice(0, 2);
  return `objects/${shard}/${randomUUID()}`;
}

function partKey(uploadId: string, partNumber: number): string {
  return `uploads/${uploadId}/part-${String(partNumber).padStart(5, "0")}`;
}

function resolveRange(range: { start: number; end: number } | null, size: number): { start: number; end: number } {
  if (size === 0) {
    if (range) throw new DriveError(416, "bad_range", "Range is not satisfiable");
    return { start: 0, end: -1 };
  }
  // A suffix range is encoded as { start: -N, end: -1 } by the HTTP layer.
  if (range && range.end === -1 && range.start < 0) {
    const suffix = -range.start;
    if (!Number.isInteger(suffix) || suffix <= 0) throw new DriveError(416, "bad_range", "Range is not satisfiable");
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) {
    throw new DriveError(416, "bad_range", "Range is not satisfiable");
  }
  return { start, end: Math.min(end, size - 1) };
}

function fileInfo(file: FileRecord): FileInfo {
  return {
    id: file.id,
    name: file.name,
    folderId: file.folderId,
    size: file.size,
    sha256: file.sha256,
    mediaType: file.mediaType,
    encrypted: file.encrypted,
    versionId: file.versionId,
    version: file.version,
    trashedAt: file.trashedAt,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

function folderInfo(folder: { id: string; name: string; parentId: string | null; trashedAt: string | null; createdAt: string; updatedAt: string }): FolderInfo {
  return {
    id: folder.id,
    name: folder.name,
    parentId: folder.parentId,
    trashedAt: folder.trashedAt,
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
}

function shareInfo(share: { id: string; fileId: string; expiresAt: string | null; revokedAt: string | null; createdAt: string }): ShareInfo {
  return { id: share.id, fileId: share.fileId, expiresAt: share.expiresAt, revokedAt: share.revokedAt, createdAt: share.createdAt };
}
