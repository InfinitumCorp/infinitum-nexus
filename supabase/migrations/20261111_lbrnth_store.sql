-- Labyrinth *LBRNTH durable store (Infinitum Corporation®).
--
-- One encrypted envelope per client organization. The Labyrinth host encrypts every
-- organization with AES-256-GCM under its own HKDF-derived key before it reaches this
-- database; Postgres never sees repository plaintext or the master key.
--
-- Never-overwrite commit rules, enforced here as well as in the host:
--   * an envelope row can only move forward by exactly one revision (compare-and-swap),
--   * an envelope row can never be deleted or renamed,
--   * a failed transaction leaves every previous revision intact.
--
-- Only the Labyrinth host's server connection reads or writes. anon/authenticated get nothing.

create schema if not exists lbrnth;
revoke all on schema lbrnth from public;
revoke all on schema lbrnth from anon, authenticated;

create table if not exists lbrnth.org_snapshots (
  org_id text primary key check (char_length(org_id) between 1 and 120),
  revision bigint not null check (revision >= 1),
  nonce bytea not null check (octet_length(nonce) = 12),
  tag bytea not null check (octet_length(tag) = 16),
  ciphertext bytea not null check (octet_length(ciphertext) <= 201326592),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function lbrnth.org_snapshot_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Labyrinth organization envelopes cannot be deleted';
  end if;
  if new.org_id <> old.org_id then
    raise exception 'Labyrinth organization envelopes cannot be renamed';
  end if;
  if new.revision <> old.revision + 1 then
    raise exception 'Labyrinth envelope revision must advance by exactly one';
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists org_snapshot_guard on lbrnth.org_snapshots;
create trigger org_snapshot_guard before update or delete on lbrnth.org_snapshots
  for each row execute function lbrnth.org_snapshot_guard();

-- Short-lived repository-only bearers. Only the SHA-256 of the bearer is stored, never the
-- bearer or the parent Cumulus ID session token. Expired rows are pruned by the host.
create table if not exists lbrnth.delegations (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  cid text not null check (char_length(cid) between 1 and 200),
  org_id text not null check (char_length(org_id) between 1 and 120),
  parent_session text not null check (char_length(parent_session) between 1 and 200),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists delegations_parent_session on lbrnth.delegations (parent_session);
create index if not exists delegations_expires_at on lbrnth.delegations (expires_at);

-- Paid-plan authority. Rows are written by an operator (or a future billing webhook);
-- a CID consent never creates one. No row, or active = false, means no access.
create table if not exists lbrnth.entitlements (
  org_id text primary key check (char_length(org_id) between 1 and 120),
  plan text not null check (char_length(plan) between 1 and 60),
  active boolean not null default true,
  source text not null check (source in ('operator', 'billing')),
  note text check (note is null or char_length(note) <= 500),
  updated_at timestamptz not null default now()
);

alter table lbrnth.org_snapshots enable row level security;
alter table lbrnth.delegations enable row level security;
alter table lbrnth.entitlements enable row level security;
revoke all on all tables in schema lbrnth from anon, authenticated;
