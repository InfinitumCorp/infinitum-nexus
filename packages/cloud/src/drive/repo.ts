import { randomUUID } from "node:crypto";
import type pg from "pg";
import { DriveError } from "./errors.ts";

export interface FolderRecord {
  id: string;
  ownerCid: string;
  parentId: string | null;
  name: string;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileRecord {
  id: string;
  ownerCid: string;
  folderId: string | null;
  name: string;
  trashedAt: string | null;
  createdAt: string;
  updatedAt: string;
  versionId: string;
  version: number;
  size: number;
  sha256: string;
  blobSha256: string;
  declaredType: string;
  mediaType: string;
  storageKey: string;
  encrypted: boolean;
  wrappedDek: string | null;
  contentSalt: string | null;
}

export interface VersionRecord {
  id: string;
  version: number;
  size: number;
  sha256: string;
  mediaType: string;
  storageKey: string;
  encrypted: boolean;
  createdAt: string;
  current: boolean;
}

export interface UploadRecord {
  id: string;
  ownerCid: string;
  folderId: string | null;
  fileId: string | null;
  name: string;
  declaredSize: number;
  declaredType: string;
  expectedSha256: string | null;
  bytesReceived: number;
  status: "open" | "completed" | "aborted";
  partSize: number;
  encrypted: boolean;
  wrappedDek: string | null;
  contentSalt: string | null;
  expiresAt: string;
}

export interface PartRecord {
  partNumber: number;
  size: number;
  sha256: string;
  storageKey: string;
}

export interface ShareRecord {
  id: string;
  fileId: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface VersionInput {
  sizeBytes: number;
  sha256: string;
  blobSha256: string;
  declaredType: string;
  mediaType: string;
  storageKey: string;
  encrypted: boolean;
  wrappedDek: string | null;
  contentSalt: string | null;
}

const FILE_SELECT = `
  SELECT f.id, f.owner_cid, f.folder_id, f.name, f.trashed_at, f.created_at, f.updated_at,
         v.id AS version_id, v.version_number, v.size_bytes, v.sha256, v.blob_sha256,
         v.declared_type, v.media_type, v.storage_key, v.encrypted, v.wrapped_dek, v.content_salt
  FROM cloud_files f
  JOIN cloud_versions v ON v.id = f.current_version_id AND v.owner_cid = f.owner_cid AND v.file_id = f.id
`;

function mapDb(err: unknown): Error {
  if (err instanceof DriveError) return err;
  const code = typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : "";
  if (code === "23505") return new DriveError(409, "conflict", "That name is already used in this folder");
  if (code === "22P02" || code === "23514" || code === "23503") return new DriveError(400, "invalid_id", "That value is not allowed");
  if (err instanceof Error) return err;
  return new Error("Database request failed");
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new DriveError(500, "bad_size", "Stored size is not valid");
  return n;
}

function folderOf(row: Record<string, unknown>): FolderRecord {
  return {
    id: String(row.id),
    ownerCid: String(row.owner_cid),
    parentId: row.parent_id ? String(row.parent_id) : null,
    name: String(row.name),
    trashedAt: iso(row.trashed_at as Date | null),
    createdAt: iso(row.created_at as Date) ?? "",
    updatedAt: iso(row.updated_at as Date) ?? "",
  };
}

function fileOf(row: Record<string, unknown>): FileRecord {
  return {
    id: String(row.id),
    ownerCid: String(row.owner_cid),
    folderId: row.folder_id ? String(row.folder_id) : null,
    name: String(row.name),
    trashedAt: iso(row.trashed_at as Date | null),
    createdAt: iso(row.created_at as Date) ?? "",
    updatedAt: iso(row.updated_at as Date) ?? "",
    versionId: String(row.version_id),
    version: num(row.version_number),
    size: num(row.size_bytes),
    sha256: String(row.sha256),
    blobSha256: String(row.blob_sha256),
    declaredType: String(row.declared_type),
    mediaType: String(row.media_type),
    storageKey: String(row.storage_key),
    encrypted: Boolean(row.encrypted),
    wrappedDek: row.wrapped_dek ? String(row.wrapped_dek) : null,
    contentSalt: row.content_salt ? String(row.content_salt) : null,
  };
}

/**
 * Every method that reads or writes a person's files takes ownerCid from the
 * Cumulus://ID session. Identifiers supplied by the client are never trusted
 * on their own.
 */
export class DriveRepo {
  readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore a rollback failure and surface the original error.
      }
      throw mapDb(err);
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async reserve(ownerCid: string, bytes: number, limitBytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new DriveError(400, "bad_size", "Size is not a valid byte count");
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0) throw new DriveError(500, "config", "Quota limit is not valid");
    await this.tx(async (client) => {
      await client.query(
        `INSERT INTO cloud_quotas (owner_cid, limit_bytes, used_bytes)
         VALUES ($1, $2, 0)
         ON CONFLICT (owner_cid) DO UPDATE SET limit_bytes = EXCLUDED.limit_bytes, updated_at = now()`,
        [ownerCid, limitBytes],
      );
      const updated = await client.query(
        `UPDATE cloud_quotas
         SET used_bytes = used_bytes + $2, updated_at = now()
         WHERE owner_cid = $1 AND used_bytes + $2 <= limit_bytes
         RETURNING used_bytes`,
        [ownerCid, bytes],
      );
      if ((updated.rowCount ?? 0) === 0) throw new DriveError(507, "quota_exceeded", "Cumulus://Cloud storage is full");
    });
  }

  async release(ownerCid: string, bytes: number): Promise<void> {
    if (bytes === 0) return;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new DriveError(400, "bad_size", "Size is not a valid byte count");
    await this.pool.query(
      `UPDATE cloud_quotas SET used_bytes = GREATEST(0, used_bytes - $2), updated_at = now() WHERE owner_cid = $1`,
      [ownerCid, bytes],
    );
  }

  async usage(ownerCid: string, limitBytes: number): Promise<{ usedBytes: number; limitBytes: number }> {
    const res = await this.pool.query(`SELECT used_bytes, limit_bytes FROM cloud_quotas WHERE owner_cid = $1`, [ownerCid]);
    const row = res.rows[0] as { used_bytes: unknown; limit_bytes: unknown } | undefined;
    if (!row) return { usedBytes: 0, limitBytes };
    return { usedBytes: num(row.used_bytes), limitBytes: num(row.limit_bytes) };
  }

  async createFolder(ownerCid: string, parentId: string | null, name: string): Promise<FolderRecord> {
    if (parentId) {
      const parent = await this.getFolder(ownerCid, parentId);
      if (!parent || parent.trashedAt) throw new DriveError(404, "not_found", "No such folder");
    }
    const res = await this.pool
      .query(`INSERT INTO cloud_folders (id, owner_cid, parent_id, name) VALUES ($1, $2, $3, $4) RETURNING *`, [
        randomUUID(),
        ownerCid,
        parentId,
        name,
      ])
      .catch((err: unknown) => {
        throw mapDb(err);
      });
    return folderOf(res.rows[0] as Record<string, unknown>);
  }

  async getFolder(ownerCid: string, id: string): Promise<FolderRecord | null> {
    const res = await this.pool.query(`SELECT * FROM cloud_folders WHERE id = $1 AND owner_cid = $2`, [id, ownerCid]);
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? folderOf(row) : null;
  }

  async listFolders(ownerCid: string, parentId: string | null, cursor: string | null, limit: number): Promise<FolderRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM cloud_folders
       WHERE owner_cid = $1 AND parent_id IS NOT DISTINCT FROM $2 AND trashed_at IS NULL
         AND ($3::text IS NULL OR name > $3)
       ORDER BY name ASC
       LIMIT $4`,
      [ownerCid, parentId, cursor, limit],
    );
    return res.rows.map((row) => folderOf(row as Record<string, unknown>));
  }

  async listTrashedFolders(ownerCid: string): Promise<FolderRecord[]> {
    const res = await this.pool.query(
      `SELECT * FROM cloud_folders WHERE owner_cid = $1 AND trashed_at IS NOT NULL ORDER BY name ASC`,
      [ownerCid],
    );
    return res.rows.map((row) => folderOf(row as Record<string, unknown>));
  }

  /** True when this folder, or one of its parents, is in the trash. */
  async folderBlocked(ownerCid: string, folderId: string | null): Promise<boolean> {
    if (!folderId) return false;
    const res = await this.pool.query(
      `WITH RECURSIVE chain AS (
         SELECT id, parent_id, trashed_at, 1 AS depth FROM cloud_folders WHERE id = $1 AND owner_cid = $2
         UNION ALL
         SELECT f.id, f.parent_id, f.trashed_at, c.depth + 1
         FROM cloud_folders f
         JOIN chain c ON f.id = c.parent_id
         WHERE f.owner_cid = $2 AND c.depth < 128
       )
       SELECT 1 FROM chain WHERE trashed_at IS NOT NULL LIMIT 1`,
      [folderId, ownerCid],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** True when newParentId is this folder or a folder inside it. */
  async folderContains(ownerCid: string, folderId: string, newParentId: string): Promise<boolean> {
    const res = await this.pool.query(
      `WITH RECURSIVE tree AS (
         SELECT id, 1 AS depth FROM cloud_folders WHERE id = $1 AND owner_cid = $2
         UNION ALL
         SELECT f.id, t.depth + 1 FROM cloud_folders f
         JOIN tree t ON f.parent_id = t.id
         WHERE f.owner_cid = $2 AND t.depth < 128
       )
       SELECT 1 FROM tree WHERE id = $3 LIMIT 1`,
      [folderId, ownerCid, newParentId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async updateFolder(ownerCid: string, id: string, patch: { name?: string; parentId?: string | null }): Promise<FolderRecord | null> {
    const current = await this.getFolder(ownerCid, id);
    if (!current || current.trashedAt) return null;
    const name = patch.name ?? current.name;
    const parentId = patch.parentId === undefined ? current.parentId : patch.parentId;
    if (parentId) {
      const parent = await this.getFolder(ownerCid, parentId);
      if (!parent || parent.trashedAt) throw new DriveError(404, "not_found", "No such folder");
      if (await this.folderContains(ownerCid, id, parentId)) {
        throw new DriveError(400, "cycle", "A folder cannot be moved into itself");
      }
    }
    const res = await this.pool
      .query(
        `UPDATE cloud_folders SET name = $3, parent_id = $4, updated_at = now()
         WHERE id = $1 AND owner_cid = $2 AND trashed_at IS NULL RETURNING *`,
        [id, ownerCid, name, parentId],
      )
      .catch((err: unknown) => {
        throw mapDb(err);
      });
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? folderOf(row) : null;
  }

  async trashFolder(ownerCid: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE cloud_folders SET trashed_at = now(), updated_at = now()
       WHERE id = $1 AND owner_cid = $2 AND trashed_at IS NULL`,
      [id, ownerCid],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async restoreFolder(ownerCid: string, id: string): Promise<FolderRecord | null> {
    const current = await this.getFolder(ownerCid, id);
    if (!current || !current.trashedAt) return null;
    if (current.parentId && (await this.folderBlocked(ownerCid, current.parentId))) {
      throw new DriveError(409, "parent_trashed", "Restore the parent folder first");
    }
    const res = await this.pool
      .query(
        `UPDATE cloud_folders SET trashed_at = NULL, updated_at = now()
         WHERE id = $1 AND owner_cid = $2 AND trashed_at IS NOT NULL RETURNING *`,
        [id, ownerCid],
      )
      .catch((err: unknown) => {
        throw mapDb(err);
      });
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? folderOf(row) : null;
  }

  async descendantFolderIds(ownerCid: string, id: string): Promise<string[]> {
    const res = await this.pool.query(
      `WITH RECURSIVE tree AS (
         SELECT id, 1 AS depth FROM cloud_folders WHERE id = $1 AND owner_cid = $2
         UNION ALL
         SELECT f.id, t.depth + 1 FROM cloud_folders f
         JOIN tree t ON f.parent_id = t.id
         WHERE f.owner_cid = $2 AND t.depth < 128
       )
       SELECT id FROM tree`,
      [id, ownerCid],
    );
    return res.rows.map((row) => String((row as { id: string }).id));
  }

  private async insertVersion(client: pg.PoolClient, fileId: string, ownerCid: string, input: VersionInput): Promise<string> {
    const versionId = randomUUID();
    const next = await client.query(`SELECT COALESCE(MAX(version_number), 0) + 1 AS n FROM cloud_versions WHERE file_id = $1 AND owner_cid = $2`, [
      fileId,
      ownerCid,
    ]);
    const version = num((next.rows[0] as { n: unknown }).n);
    await client.query(
      `INSERT INTO cloud_versions (
         id, file_id, owner_cid, version_number, size_bytes, sha256, blob_sha256, declared_type, media_type,
         storage_key, encrypted, wrapped_dek, content_salt
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        versionId,
        fileId,
        ownerCid,
        version,
        input.sizeBytes,
        input.sha256,
        input.blobSha256,
        input.declaredType,
        input.mediaType,
        input.storageKey,
        input.encrypted,
        input.wrappedDek,
        input.contentSalt,
      ],
    );
    await client.query(`UPDATE cloud_files SET current_version_id = $1, updated_at = now() WHERE id = $2 AND owner_cid = $3`, [
      versionId,
      fileId,
      ownerCid,
    ]);
    return versionId;
  }

  async insertFile(ownerCid: string, folderId: string | null, name: string, input: VersionInput): Promise<FileRecord> {
    const fileId = randomUUID();
    await this.tx(async (client) => {
      if (folderId) {
        const parent = await client.query(
          `SELECT id FROM cloud_folders WHERE id = $1 AND owner_cid = $2 AND trashed_at IS NULL`,
          [folderId, ownerCid],
        );
        if ((parent.rowCount ?? 0) === 0) throw new DriveError(404, "not_found", "No such folder");
      }
      await client.query(`INSERT INTO cloud_files (id, owner_cid, folder_id, name) VALUES ($1, $2, $3, $4)`, [
        fileId,
        ownerCid,
        folderId,
        name,
      ]);
      await this.insertVersion(client, fileId, ownerCid, input);
    });
    const file = await this.getFile(ownerCid, fileId);
    if (!file) throw new DriveError(500, "internal", "File was not saved");
    return file;
  }

  async addVersion(ownerCid: string, fileId: string, input: VersionInput): Promise<FileRecord> {
    await this.tx(async (client) => {
      const file = await client.query(`SELECT id, trashed_at FROM cloud_files WHERE id = $1 AND owner_cid = $2 FOR UPDATE`, [fileId, ownerCid]);
      const row = file.rows[0] as { trashed_at: Date | null } | undefined;
      if (!row || row.trashed_at) throw new DriveError(404, "not_found", "No such file");
      await this.insertVersion(client, fileId, ownerCid, input);
    });
    const file = await this.getFile(ownerCid, fileId);
    if (!file) throw new DriveError(404, "not_found", "No such file");
    return file;
  }

  async getFile(ownerCid: string, id: string): Promise<FileRecord | null> {
    const res = await this.pool.query(`${FILE_SELECT} WHERE f.owner_cid = $1 AND f.id = $2`, [ownerCid, id]);
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? fileOf(row) : null;
  }

  async listFiles(ownerCid: string, folderId: string | null, cursor: string | null, limit: number): Promise<FileRecord[]> {
    const res = await this.pool.query(
      `${FILE_SELECT}
       WHERE f.owner_cid = $1 AND f.folder_id IS NOT DISTINCT FROM $2 AND f.trashed_at IS NULL
         AND ($3::text IS NULL OR f.name > $3)
       ORDER BY f.name ASC
       LIMIT $4`,
      [ownerCid, folderId, cursor, limit],
    );
    return res.rows.map((row) => fileOf(row as Record<string, unknown>));
  }

  async listTrashedFiles(ownerCid: string): Promise<FileRecord[]> {
    const res = await this.pool.query(
      `${FILE_SELECT} WHERE f.owner_cid = $1 AND f.trashed_at IS NOT NULL ORDER BY f.name ASC`,
      [ownerCid],
    );
    return res.rows.map((row) => fileOf(row as Record<string, unknown>));
  }

  async updateFile(ownerCid: string, id: string, patch: { name?: string; folderId?: string | null }): Promise<FileRecord | null> {
    const current = await this.getFile(ownerCid, id);
    if (!current || current.trashedAt) return null;
    const name = patch.name ?? current.name;
    const folderId = patch.folderId === undefined ? current.folderId : patch.folderId;
    if (folderId) {
      const folder = await this.getFolder(ownerCid, folderId);
      if (!folder || folder.trashedAt) throw new DriveError(404, "not_found", "No such folder");
    }
    await this.pool
      .query(
        `UPDATE cloud_files SET name = $3, folder_id = $4, updated_at = now()
         WHERE id = $1 AND owner_cid = $2 AND trashed_at IS NULL`,
        [id, ownerCid, name, folderId],
      )
      .catch((err: unknown) => {
        throw mapDb(err);
      });
    return this.getFile(ownerCid, id);
  }

  async trashFile(ownerCid: string, id: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE cloud_files SET trashed_at = now(), updated_at = now()
       WHERE id = $1 AND owner_cid = $2 AND trashed_at IS NULL`,
      [id, ownerCid],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async restoreFile(ownerCid: string, id: string): Promise<FileRecord | null> {
    const current = await this.getFile(ownerCid, id);
    if (!current || !current.trashedAt) return null;
    if (await this.folderBlocked(ownerCid, current.folderId)) throw new DriveError(409, "parent_trashed", "Restore the parent folder first");
    await this.pool
      .query(`UPDATE cloud_files SET trashed_at = NULL, updated_at = now() WHERE id = $1 AND owner_cid = $2 AND trashed_at IS NOT NULL`, [
        id,
        ownerCid,
      ])
      .catch((err: unknown) => {
        throw mapDb(err);
      });
    return this.getFile(ownerCid, id);
  }

  async listVersions(ownerCid: string, fileId: string): Promise<VersionRecord[] | null> {
    const file = await this.pool.query(`SELECT current_version_id FROM cloud_files WHERE id = $1 AND owner_cid = $2`, [fileId, ownerCid]);
    const current = (file.rows[0] as { current_version_id: string | null } | undefined)?.current_version_id;
    if (!current && (file.rowCount ?? 0) === 0) return null;
    const res = await this.pool.query(
      `SELECT id, version_number, size_bytes, sha256, media_type, storage_key, encrypted, created_at
       FROM cloud_versions WHERE file_id = $1 AND owner_cid = $2 ORDER BY version_number ASC`,
      [fileId, ownerCid],
    );
    return res.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        version: num(r.version_number),
        size: num(r.size_bytes),
        sha256: String(r.sha256),
        mediaType: String(r.media_type),
        storageKey: String(r.storage_key),
        encrypted: Boolean(r.encrypted),
        createdAt: iso(r.created_at as Date) ?? "",
        current: String(r.id) === current,
      };
    });
  }

  /** Delete one non-current version and release its bytes. Returns the blob key. */
  async deleteVersion(ownerCid: string, fileId: string, versionId: string): Promise<{ storageKey: string; bytes: number } | null> {
    return this.tx(async (client) => {
      const res = await client.query(
        `SELECT v.storage_key, v.size_bytes, f.current_version_id
         FROM cloud_versions v
         JOIN cloud_files f ON f.id = v.file_id AND f.owner_cid = v.owner_cid
         WHERE v.id = $1 AND v.file_id = $2 AND v.owner_cid = $3
         FOR UPDATE`,
        [versionId, fileId, ownerCid],
      );
      const row = res.rows[0] as { storage_key: string; size_bytes: unknown; current_version_id: string } | undefined;
      if (!row) return null;
      if (row.current_version_id === versionId) throw new DriveError(400, "current_version", "The current version stays until the file is purged");
      await client.query(`DELETE FROM cloud_versions WHERE id = $1 AND owner_cid = $2`, [versionId, ownerCid]);
      const bytes = num(row.size_bytes);
      await client.query(`UPDATE cloud_quotas SET used_bytes = GREATEST(0, used_bytes - $2), updated_at = now() WHERE owner_cid = $1`, [
        ownerCid,
        bytes,
      ]);
      return { storageKey: row.storage_key, bytes };
    });
  }

  /** Remove the file row, every version, and the quota those versions held. Blobs are deleted by the caller. */
  async purgeFile(ownerCid: string, id: string): Promise<{ keys: string[]; bytes: number } | null> {
    return this.tx(async (client) => {
      const versions = await client.query(`SELECT storage_key, size_bytes FROM cloud_versions WHERE file_id = $1 AND owner_cid = $2`, [id, ownerCid]);
      const deleted = await client.query(`DELETE FROM cloud_files WHERE id = $1 AND owner_cid = $2`, [id, ownerCid]);
      if ((deleted.rowCount ?? 0) === 0) return null;
      const keys = versions.rows.map((row) => String((row as { storage_key: string }).storage_key));
      const bytes = versions.rows.reduce((sum, row) => sum + num((row as { size_bytes: unknown }).size_bytes), 0);
      if (bytes > 0) {
        await client.query(`UPDATE cloud_quotas SET used_bytes = GREATEST(0, used_bytes - $2), updated_at = now() WHERE owner_cid = $1`, [
          ownerCid,
          bytes,
        ]);
      }
      return { keys, bytes };
    });
  }

  async fileIdsInFolders(ownerCid: string, folderIds: string[]): Promise<string[]> {
    if (folderIds.length === 0) return [];
    const res = await this.pool.query(`SELECT id FROM cloud_files WHERE owner_cid = $1 AND folder_id = ANY($2::uuid[])`, [ownerCid, folderIds]);
    return res.rows.map((row) => String((row as { id: string }).id));
  }

  async purgeFolder(ownerCid: string, id: string): Promise<{ keys: string[]; bytes: number } | null> {
    const ids = await this.descendantFolderIds(ownerCid, id);
    if (ids.length === 0) return null;
    const fileIds = await this.fileIdsInFolders(ownerCid, ids);
    const keys: string[] = [];
    let bytes = 0;
    for (const fileId of fileIds) {
      const purged = await this.purgeFile(ownerCid, fileId);
      if (!purged) continue;
      keys.push(...purged.keys);
      bytes += purged.bytes;
    }
    const deleted = await this.pool.query(`DELETE FROM cloud_folders WHERE id = $1 AND owner_cid = $2`, [id, ownerCid]);
    if ((deleted.rowCount ?? 0) === 0 && fileIds.length === 0) return null;
    return { keys, bytes };
  }

  async createUpload(input: {
    ownerCid: string;
    folderId: string | null;
    fileId: string | null;
    name: string;
    declaredSize: number;
    declaredType: string;
    expectedSha256: string | null;
    partSize: number;
    encrypted: boolean;
    wrappedDek: string | null;
    contentSalt: string | null;
    expiresAt: string;
  }): Promise<UploadRecord> {
    const id = randomUUID();
    const res = await this.pool.query(
      `INSERT INTO cloud_uploads (
         id, owner_cid, folder_id, file_id, name, declared_size, declared_type, expected_sha256,
         part_size, encrypted, wrapped_dek, content_salt, expires_at, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open') RETURNING *`,
      [
        id,
        input.ownerCid,
        input.folderId,
        input.fileId,
        input.name,
        input.declaredSize,
        input.declaredType,
        input.expectedSha256,
        input.partSize,
        input.encrypted,
        input.wrappedDek,
        input.contentSalt,
        input.expiresAt,
      ],
    );
    return uploadOf(res.rows[0] as Record<string, unknown>);
  }

  async getUpload(ownerCid: string, id: string): Promise<UploadRecord | null> {
    const res = await this.pool.query(`SELECT * FROM cloud_uploads WHERE id = $1 AND owner_cid = $2`, [id, ownerCid]);
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? uploadOf(row) : null;
  }

  async parts(ownerCid: string, uploadId: string): Promise<PartRecord[]> {
    const res = await this.pool.query(
      `SELECT p.part_number, p.size_bytes, p.sha256, p.storage_key
       FROM cloud_upload_parts p
       JOIN cloud_uploads u ON u.id = p.upload_id
       WHERE p.upload_id = $1 AND u.owner_cid = $2
       ORDER BY p.part_number ASC`,
      [uploadId, ownerCid],
    );
    return res.rows.map((row) => {
      const r = row as Record<string, unknown>;
      return { partNumber: num(r.part_number), size: num(r.size_bytes), sha256: String(r.sha256), storageKey: String(r.storage_key) };
    });
  }

  /** Reject the part when the running total would pass the size reserved at the start. */
  async assertPartFits(ownerCid: string, uploadId: string, partNumber: number, size: number, now: Date): Promise<void> {
    await this.tx(async (client) => {
      const upload = await client.query(
        `SELECT declared_size, status, expires_at FROM cloud_uploads WHERE id = $1 AND owner_cid = $2 FOR UPDATE`,
        [uploadId, ownerCid],
      );
      const row = upload.rows[0] as { declared_size: unknown; status: string; expires_at: Date } | undefined;
      if (!row || row.status !== "open") throw new DriveError(404, "not_found", "No such upload");
      if (new Date(row.expires_at).getTime() <= now.getTime()) throw new DriveError(410, "upload_expired", "This upload has expired");
      const sum = await client.query(
        `SELECT COALESCE(SUM(size_bytes), 0) AS n FROM cloud_upload_parts WHERE upload_id = $1 AND part_number <> $2`,
        [uploadId, partNumber],
      );
      const next = num((sum.rows[0] as { n: unknown }).n) + size;
      if (next > num(row.declared_size)) throw new DriveError(413, "too_large", "Upload parts are larger than the declared size");
    });
  }

  async savePart(ownerCid: string, uploadId: string, part: PartRecord): Promise<void> {
    await this.tx(async (client) => {
      const upload = await client.query(`SELECT id, status FROM cloud_uploads WHERE id = $1 AND owner_cid = $2 FOR UPDATE`, [uploadId, ownerCid]);
      const row = upload.rows[0] as { status: string } | undefined;
      if (!row || row.status !== "open") throw new DriveError(404, "not_found", "No such upload");
      await client.query(
        `INSERT INTO cloud_upload_parts (upload_id, part_number, size_bytes, sha256, storage_key)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (upload_id, part_number) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256`,
        [uploadId, part.partNumber, part.size, part.sha256, part.storageKey],
      );
      await client.query(
        `UPDATE cloud_uploads SET bytes_received = (
           SELECT COALESCE(SUM(size_bytes), 0) FROM cloud_upload_parts WHERE upload_id = $1
         ) WHERE id = $1 AND owner_cid = $2`,
        [uploadId, ownerCid],
      );
    });
  }

  async finishUpload(ownerCid: string, id: string, status: "completed" | "aborted"): Promise<UploadRecord | null> {
    const res = await this.pool.query(
      `UPDATE cloud_uploads SET status = $3 WHERE id = $1 AND owner_cid = $2 AND status = 'open' RETURNING *`,
      [id, ownerCid, status],
    );
    const row = res.rows[0] as Record<string, unknown> | undefined;
    return row ? uploadOf(row) : null;
  }

  async expiredUploads(now: Date): Promise<UploadRecord[]> {
    const res = await this.pool.query(`SELECT * FROM cloud_uploads WHERE status = 'open' AND expires_at <= $1`, [now.toISOString()]);
    return res.rows.map((row) => uploadOf(row as Record<string, unknown>));
  }

  async createShare(ownerCid: string, fileId: string, tokenHash: string, expiresAt: string | null): Promise<ShareRecord> {
    const file = await this.getFile(ownerCid, fileId);
    if (!file) throw new DriveError(404, "not_found", "No such file");
    const res = await this.pool.query(
      `INSERT INTO cloud_shares (id, owner_cid, file_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [randomUUID(), ownerCid, fileId, tokenHash, expiresAt],
    );
    return shareOf(res.rows[0] as Record<string, unknown>);
  }

  async listShares(ownerCid: string, fileId: string): Promise<ShareRecord[] | null> {
    const file = await this.getFile(ownerCid, fileId);
    if (!file) return null;
    const res = await this.pool.query(
      `SELECT * FROM cloud_shares WHERE owner_cid = $1 AND file_id = $2 ORDER BY created_at ASC`,
      [ownerCid, fileId],
    );
    return res.rows.map((row) => shareOf(row as Record<string, unknown>));
  }

  async revokeShare(ownerCid: string, shareId: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE cloud_shares SET revoked_at = now() WHERE id = $1 AND owner_cid = $2 AND revoked_at IS NULL`,
      [shareId, ownerCid],
    );
    if ((res.rowCount ?? 0) > 0) return true;
    const exists = await this.pool.query(`SELECT id FROM cloud_shares WHERE id = $1 AND owner_cid = $2`, [shareId, ownerCid]);
    return (exists.rowCount ?? 0) > 0;
  }

  /** Public capability lookup. The token hash is the only key; the owner is whatever row it points at. */
  async shareByToken(tokenHash: string, now: Date): Promise<{ share: ShareRecord; file: FileRecord } | null> {
    const res = await this.pool.query(
      `SELECT owner_cid, file_id FROM cloud_shares
       WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
      [tokenHash, now.toISOString()],
    );
    const row = res.rows[0] as { owner_cid: string; file_id: string } | undefined;
    if (!row) return null;
    const file = await this.getFile(row.owner_cid, row.file_id);
    if (!file || file.trashedAt || (await this.folderBlocked(row.owner_cid, file.folderId))) return null;
    const shareRes = await this.pool.query(`SELECT * FROM cloud_shares WHERE token_hash = $1 AND owner_cid = $2`, [tokenHash, row.owner_cid]);
    const shareRow = shareRes.rows[0] as Record<string, unknown> | undefined;
    if (!shareRow) return null;
    return { share: shareOf(shareRow), file };
  }
}

function uploadOf(row: Record<string, unknown>): UploadRecord {
  return {
    id: String(row.id),
    ownerCid: String(row.owner_cid),
    folderId: row.folder_id ? String(row.folder_id) : null,
    fileId: row.file_id ? String(row.file_id) : null,
    name: String(row.name),
    declaredSize: num(row.declared_size),
    declaredType: String(row.declared_type),
    expectedSha256: row.expected_sha256 ? String(row.expected_sha256) : null,
    bytesReceived: num(row.bytes_received),
    status: String(row.status) as UploadRecord["status"],
    partSize: num(row.part_size),
    encrypted: Boolean(row.encrypted),
    wrappedDek: row.wrapped_dek ? String(row.wrapped_dek) : null,
    contentSalt: row.content_salt ? String(row.content_salt) : null,
    expiresAt: iso(row.expires_at as Date) ?? "",
  };
}

function shareOf(row: Record<string, unknown>): ShareRecord {
  return {
    id: String(row.id),
    fileId: String(row.file_id),
    expiresAt: iso(row.expires_at as Date | null),
    revokedAt: iso(row.revoked_at as Date | null),
    createdAt: iso(row.created_at as Date) ?? "",
  };
}
