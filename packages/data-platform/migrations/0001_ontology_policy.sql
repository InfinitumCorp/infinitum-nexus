-- © Infinitum Corporation®. All rights reserved.
-- Postgres schema for the authoritative records and the serving copy of the ontology.
-- Event data stays in the lakehouse (object storage); Postgres holds policy, tenancy-derived
-- access and the current ontology objects for low-latency authorized reads.

CREATE TABLE IF NOT EXISTS policy_records (
  id              text PRIMARY KEY,
  tenant_id       text NOT NULL,
  product         text NOT NULL,
  purposes        text[] NOT NULL,
  retention_days  integer CHECK (retention_days IS NULL OR retention_days > 0),
  export_allowed  boolean NOT NULL DEFAULT false,
  source_rights   text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, product),
  CHECK (product NOT IN ('aether', 'aether-mil', 'argus', 'argus-mil', 'eon', 'odin'))
);

CREATE TABLE IF NOT EXISTS opt_ins (
  product     text NOT NULL,
  subject_id  text NOT NULL,          -- tenant-scoped pseudonym, never a raw Cumulus ID
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (product, subject_id)
);

CREATE TABLE IF NOT EXISTS product_credentials (
  key_id            text PRIMARY KEY,
  product           text NOT NULL,
  secret_ref        text NOT NULL,     -- name in the secret manager; the secret itself is not stored here
  tenants           text[],
  quota_per_minute  integer NOT NULL DEFAULT 60000,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ontology_objects (
  tenant_id       text NOT NULL,
  type            text NOT NULL,
  id              text NOT NULL,
  owner           text,
  readers         text[] NOT NULL DEFAULT '{}',
  classification  text NOT NULL CHECK (classification IN ('public', 'internal', 'confidential', 'restricted')),
  properties      jsonb NOT NULL DEFAULT '{}',
  source_events   text[] NOT NULL DEFAULT '{}',
  updated_at      timestamptz NOT NULL,
  search          tsvector GENERATED ALWAYS AS (to_tsvector('simple', type || ' ' || id || ' ' || properties::text)) STORED,
  PRIMARY KEY (tenant_id, type, id)
);
CREATE INDEX IF NOT EXISTS ontology_objects_search ON ontology_objects USING gin (search);
CREATE INDEX IF NOT EXISTS ontology_objects_readers ON ontology_objects USING gin (readers);

CREATE TABLE IF NOT EXISTS ontology_links (
  tenant_id  text NOT NULL,
  type       text NOT NULL,
  from_ref   text NOT NULL,
  to_ref     text NOT NULL,
  PRIMARY KEY (tenant_id, type, from_ref, to_ref)
);

-- Row-level security: a session sets app.tenant_id and app.subject_id after verifying the
-- Cumulus ID session; reads then only see objects the subject may read.
ALTER TABLE ontology_objects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ontology_read ON ontology_objects;
CREATE POLICY ontology_read ON ontology_objects FOR SELECT USING (
  tenant_id = current_setting('app.tenant_id', true)
  AND (
    owner = current_setting('app.subject_id', true)
    OR current_setting('app.subject_id', true) = ANY (readers)
    OR (owner IS NULL AND cardinality(readers) = 0)
  )
);

CREATE TABLE IF NOT EXISTS deletion_log (
  tenant_id   text NOT NULL,
  object_id   text NOT NULL,
  event_id    text NOT NULL,
  dataset     text NOT NULL,
  rows        integer NOT NULL,
  deleted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, object_id, dataset)
);
