-- Cumulus data platform on the Supabase free tier (eu-west-1, Ireland): event store and
-- search, dataset catalog, and the differential-privacy budget ledger.
--
-- The schema is not exposed through the Data API (PostgREST), and RLS is on with policies
-- only for the gateway's own role. The role is created by an operator with a SCRAM verifier
-- generated outside the repository; no password or verifier is ever committed:
--   create role data_platform_gateway login noinherit password '<SCRAM-SHA-256 verifier>';
-- then re-run the grants block at the end of this file.

create schema if not exists data_platform;

create table if not exists data_platform.datasets (
  name        text primary key,
  product     text not null,
  spec        jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists data_platform.events (
  event_id        uuid primary key,
  product         text not null,
  tenant          text not null,
  cid             text,            -- keyed pseudonym, never the raw Cumulus ID
  event_type      text not null,
  schema_version  integer not null,
  occurred_at     timestamptz not null,
  region          text not null check (region in ('EU', 'US', 'RU')),
  consent         text[] not null default '{}',
  object_type     text,
  object_id       text,
  text            text not null default '',
  payload         jsonb not null,  -- already redacted by the gateway
  tsv             tsvector generated always as (to_tsvector('simple', text)) stored,
  ingested_at     timestamptz not null default now()
);

create index if not exists events_scope_time on data_platform.events (product, tenant, occurred_at desc, (event_id::text) desc);
create index if not exists events_object on data_platform.events (product, tenant, object_type, object_id);
create index if not exists events_type on data_platform.events (product, tenant, event_type, occurred_at desc);
create index if not exists events_tsv on data_platform.events using gin (tsv);
-- Right to erasure: find every event about one person (by CID pseudonym).
create index if not exists events_cid on data_platform.events (cid) where cid is not null;

create table if not exists data_platform.privacy_budget (
  dataset  text primary key,
  spent    double precision not null default 0 check (spent >= 0)
);

-- Data-quality runs measured at ingest: check names and numbers only, never event values.
create table if not exists data_platform.quality_runs (
  id          bigint generated always as identity primary key,
  dataset     text not null,
  product     text not null,
  checked_at  timestamptz not null,
  ok          boolean not null,
  rows        integer not null,
  metrics     jsonb not null,
  results     jsonb not null
);
create index if not exists quality_runs_dataset_time on data_platform.quality_runs (dataset, checked_at desc);

alter table data_platform.datasets enable row level security;
alter table data_platform.quality_runs enable row level security;
alter table data_platform.events enable row level security;
alter table data_platform.privacy_budget enable row level security;

-- Retention: delete events older than their dataset's retentionDays. Run daily (pg_cron or
-- the gateway's maintenance call); free-tier storage is 500 MB, so this matters.
create or replace function data_platform.purge_expired_events() returns bigint
language sql security invoker set search_path = data_platform, pg_temp as $$
  with gone as (
    delete from data_platform.events e
    using data_platform.datasets d
    where d.name = e.event_type
      and e.occurred_at < now() - make_interval(days => (d.spec->>'retentionDays')::int)
    returning 1
  )
  select count(*) from gone;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'data_platform_gateway') then
    raise notice 'data_platform_gateway does not exist yet; create it, then re-run this migration';
    return;
  end if;
  execute 'alter role data_platform_gateway set search_path = data_platform';
  execute 'alter role data_platform_gateway connection limit 10';
  execute 'grant usage on schema data_platform to data_platform_gateway';
  execute 'grant select, insert, update on data_platform.datasets to data_platform_gateway';
  execute 'grant select, insert, delete on data_platform.events to data_platform_gateway';
  execute 'grant select, insert, update on data_platform.privacy_budget to data_platform_gateway';
  execute 'grant execute on function data_platform.purge_expired_events() to data_platform_gateway';
  execute 'grant select, insert, delete on data_platform.quality_runs to data_platform_gateway';
  execute 'alter table data_platform.quality_runs force row level security';
  if not exists (select 1 from pg_policies where schemaname = 'data_platform' and tablename = 'quality_runs' and policyname = 'gateway_all') then
    execute 'create policy gateway_all on data_platform.quality_runs for all to data_platform_gateway using (true) with check (true)';
  end if;
  execute 'alter table data_platform.datasets force row level security';
  execute 'alter table data_platform.events force row level security';
  execute 'alter table data_platform.privacy_budget force row level security';
  if not exists (select 1 from pg_policies where schemaname = 'data_platform' and tablename = 'datasets' and policyname = 'gateway_all') then
    execute 'create policy gateway_all on data_platform.datasets for all to data_platform_gateway using (true) with check (true)';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'data_platform' and tablename = 'events' and policyname = 'gateway_all') then
    execute 'create policy gateway_all on data_platform.events for all to data_platform_gateway using (true) with check (true)';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'data_platform' and tablename = 'privacy_budget' and policyname = 'gateway_all') then
    execute 'create policy gateway_all on data_platform.privacy_budget for all to data_platform_gateway using (true) with check (true)';
  end if;
end $$;

-- Dashboards (Superset) read through this view only. security_invoker makes the reader's own
-- column grants and RLS policy apply, so the pseudonym (cid), free text and payload are never
-- readable by the BI role, even with hand-written SQL.
create or replace view data_platform.events_bi with (security_invoker = true) as
  select event_id, product, tenant, event_type, schema_version, occurred_at, region,
         object_type, object_id, ingested_at
  from data_platform.events;

-- Optional read-only role for Superset, created the same way as the gateway role:
--   create role data_platform_reader login noinherit password '<SCRAM-SHA-256 verifier>';
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'data_platform_reader') then
    raise notice 'data_platform_reader does not exist; skipping BI grants';
    return;
  end if;
  execute 'alter role data_platform_reader set search_path = data_platform';
  execute 'alter role data_platform_reader set default_transaction_read_only = on';
  execute 'alter role data_platform_reader connection limit 5';
  execute 'grant usage on schema data_platform to data_platform_reader';
  execute 'grant select (event_id, product, tenant, event_type, schema_version, occurred_at, region,
                         object_type, object_id, ingested_at) on data_platform.events to data_platform_reader';
  execute 'grant select (name, product, updated_at) on data_platform.datasets to data_platform_reader';
  execute 'grant select on data_platform.events_bi to data_platform_reader';
  execute 'grant select on data_platform.quality_runs to data_platform_reader';
  if not exists (select 1 from pg_policies where schemaname = 'data_platform' and tablename = 'quality_runs' and policyname = 'reader_select') then
    execute 'create policy reader_select on data_platform.quality_runs for select to data_platform_reader using (true)';
  end if;
  execute 'alter table data_platform.events force row level security';
  execute 'alter table data_platform.datasets force row level security';
  if not exists (select 1 from pg_policies where schemaname = 'data_platform' and tablename = 'events' and policyname = 'reader_select') then
    execute 'create policy reader_select on data_platform.events for select to data_platform_reader using (true)';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'data_platform' and tablename = 'datasets' and policyname = 'reader_select') then
    execute 'create policy reader_select on data_platform.datasets for select to data_platform_reader using (true)';
  end if;
end $$;

-- Retention without depending on the gateway being up (or on Cloud Run, where background
-- threads are throttled): when pg_cron is enabled (Database > Extensions in Supabase, free),
-- purge daily at 03:17 UTC. Rescheduling under the same name replaces the job.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    -- RLS is forced on events, so the job's role must bypass it or the purge deletes nothing.
    if not (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) then
      raise notice '% cannot bypass RLS; not scheduling the purge (the gateway runs it)', current_user;
      return;
    end if;
    perform cron.schedule('data-platform-purge', '17 3 * * *', 'select data_platform.purge_expired_events()');
  else
    raise notice 'pg_cron is not enabled; the gateway runs the daily purge instead';
  end if;
end $$;
