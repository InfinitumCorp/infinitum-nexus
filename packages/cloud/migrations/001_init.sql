-- Cumulus://Cloud Drive metadata. Bytes live on the local filesystem; this database
-- records files, folders, versions, shares, uploads, and quotas.

CREATE TABLE cloud_quotas (
  owner_cid TEXT PRIMARY KEY,
  limit_bytes BIGINT NOT NULL CHECK (limit_bytes >= 0),
  used_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cloud_folders (
  id UUID PRIMARY KEY,
  owner_cid TEXT NOT NULL,
  parent_id UUID REFERENCES cloud_folders (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  trashed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (parent_id IS DISTINCT FROM id)
);

-- NULL parent_id would not collide in a plain unique index, so root names are keyed
-- with a sentinel. The sentinel is expression-only and is never stored as an id.
CREATE UNIQUE INDEX cloud_folders_live_name
  ON cloud_folders (owner_cid, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name)
  WHERE trashed_at IS NULL;

CREATE INDEX cloud_folders_owner_parent ON cloud_folders (owner_cid, parent_id);

CREATE TABLE cloud_files (
  id UUID PRIMARY KEY,
  owner_cid TEXT NOT NULL,
  folder_id UUID REFERENCES cloud_folders (id),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
  current_version_id UUID,
  trashed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cloud_files_live_name
  ON cloud_files (owner_cid, COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), name)
  WHERE trashed_at IS NULL;

CREATE INDEX cloud_files_owner_folder ON cloud_files (owner_cid, folder_id);
CREATE INDEX cloud_files_owner_trash ON cloud_files (owner_cid) WHERE trashed_at IS NOT NULL;

CREATE TABLE cloud_versions (
  id UUID PRIMARY KEY,
  file_id UUID NOT NULL REFERENCES cloud_files (id) ON DELETE CASCADE,
  owner_cid TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  blob_sha256 TEXT NOT NULL CHECK (blob_sha256 ~ '^[0-9a-f]{64}$'),
  declared_type TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  encrypted BOOLEAN NOT NULL DEFAULT FALSE,
  wrapped_dek TEXT,
  content_salt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_id, version_number),
  CHECK (encrypted = FALSE OR (wrapped_dek IS NOT NULL AND content_salt IS NOT NULL))
);

CREATE INDEX cloud_versions_file ON cloud_versions (file_id, owner_cid);

CREATE TABLE cloud_shares (
  id UUID PRIMARY KEY,
  owner_cid TEXT NOT NULL,
  file_id UUID NOT NULL REFERENCES cloud_files (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX cloud_shares_file ON cloud_shares (owner_cid, file_id);

CREATE TABLE cloud_uploads (
  id UUID PRIMARY KEY,
  owner_cid TEXT NOT NULL,
  folder_id UUID,
  file_id UUID,
  name TEXT NOT NULL,
  declared_size BIGINT NOT NULL CHECK (declared_size >= 0),
  declared_type TEXT NOT NULL,
  expected_sha256 TEXT,
  bytes_received BIGINT NOT NULL DEFAULT 0 CHECK (bytes_received >= 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'aborted')),
  part_size INTEGER NOT NULL CHECK (part_size > 0),
  encrypted BOOLEAN NOT NULL DEFAULT FALSE,
  wrapped_dek TEXT,
  content_salt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (encrypted = FALSE OR (wrapped_dek IS NOT NULL AND content_salt IS NOT NULL))
);

CREATE INDEX cloud_uploads_owner ON cloud_uploads (owner_cid, status);

CREATE TABLE cloud_upload_parts (
  upload_id UUID NOT NULL REFERENCES cloud_uploads (id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  storage_key TEXT NOT NULL UNIQUE,
  PRIMARY KEY (upload_id, part_number)
);
