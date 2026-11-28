-- Cumulus://ID as rows (relational storage plan, phase 4, hosted through nexus-store).
--
-- Tables: one row per account, sign-in link, passkey, session, grant, org and single-use item, in the
-- cumulus_id schema (not exposed by the Data API; RLS on with no policies; no grants to public roles).
-- Same layout as packages/cid cidSchemaSql("cumulus_id").
--
-- Products don't connect to Postgres. They call the private nexus-store edge function, which calls:
--   public.cid_read(p_ops)                         whitelisted reads, several per call (sessionBundle:
--                                                  session + account + grants in one)
--   public.nexus_commit_cid(p_entries, p_docs, p_cid)
--                                                  nexus_commit plus the request's ID writes, in ONE
--                                                  transaction; every write carries the value the
--                                                  request read, and a row that changed since then
--                                                  raises nexus_conflict (the request re-runs)
-- and cumulus_id.refresh_from_document() copies the `cid` document into the rows (backfill).

create schema if not exists cumulus_id;

create table if not exists cumulus_id.cid_accounts (
  seq bigserial,
  cid text primary key,
  username text not null unique,
  org_id text,
  data jsonb not null
);
create index if not exists cid_accounts_org on cumulus_id.cid_accounts (org_id) where org_id is not null;
create table if not exists cumulus_id.cid_identities (key text primary key, cid text not null);
create table if not exists cumulus_id.cid_federation (key text primary key, cid text not null);
create table if not exists cumulus_id.cid_authenticators (
  seq bigserial,
  id text primary key,
  cid text not null,
  credential_id text not null unique,
  data jsonb not null
);
create index if not exists cid_authenticators_cid on cumulus_id.cid_authenticators (cid);
create table if not exists cumulus_id.cid_sessions (
  seq bigserial,
  id text primary key,
  cid text not null,
  token_hash text not null unique,
  data jsonb not null
);
create index if not exists cid_sessions_cid on cumulus_id.cid_sessions (cid);
create table if not exists cumulus_id.cid_grants (
  seq bigserial,
  cid text not null,
  app text not null,
  data jsonb not null,
  primary key (cid, app)
);
create table if not exists cumulus_id.cid_orgs (id text primary key, data jsonb not null);
create table if not exists cumulus_id.cid_pending (
  kind text not null,
  key text not null,
  expires_at bigint not null,
  data jsonb not null,
  primary key (kind, key)
);
create index if not exists cid_pending_expiry on cumulus_id.cid_pending (kind, expires_at);

alter table cumulus_id.cid_accounts enable row level security;
alter table cumulus_id.cid_identities enable row level security;
alter table cumulus_id.cid_federation enable row level security;
alter table cumulus_id.cid_authenticators enable row level security;
alter table cumulus_id.cid_sessions enable row level security;
alter table cumulus_id.cid_grants enable row level security;
alter table cumulus_id.cid_orgs enable row level security;
alter table cumulus_id.cid_pending enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Reads. p_ops: [{ "op": "...", ...args }]. Returns one result per op, in order:
-- an entity (jsonb or null), a cid (text or null), or a list of entities.
create or replace function public.cid_read(p_ops jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  o jsonb;
  r jsonb;
  out jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_ops) <> 'array' or jsonb_array_length(p_ops) > 50 then
    raise exception 'cid_read: 1 to 50 ops';
  end if;
  for o in select value from jsonb_array_elements(p_ops) loop
    r := case o->>'op'
      when 'account' then (select data from cumulus_id.cid_accounts where cid = o->>'cid')
      when 'cidForUsername' then (select to_jsonb(cid) from cumulus_id.cid_accounts where username = o->>'username')
      when 'accountsInOrg' then coalesce((select jsonb_agg(data order by seq) from cumulus_id.cid_accounts where org_id = o->>'orgId'), '[]')
      when 'allAccounts' then coalesce((select jsonb_agg(data order by seq) from cumulus_id.cid_accounts), '[]')
      when 'cidForIdentity' then (select to_jsonb(cid) from cumulus_id.cid_identities where key = o->>'key')
      when 'cidForFederation' then (select to_jsonb(cid) from cumulus_id.cid_federation where key = o->>'key')
      when 'authenticator' then (select data from cumulus_id.cid_authenticators where id = o->>'id')
      when 'authenticatorByCredential' then (select data from cumulus_id.cid_authenticators where credential_id = o->>'credentialId')
      when 'authenticatorsOf' then coalesce((select jsonb_agg(data order by seq) from cumulus_id.cid_authenticators where cid = o->>'cid'), '[]')
      when 'session' then (select data from cumulus_id.cid_sessions where id = o->>'id')
      when 'sessionByTokenHash' then (select data from cumulus_id.cid_sessions where token_hash = o->>'tokenHash')
      -- The session behind a sign-in token, its account and the account's grants: everything a signed-in
      -- request checks, in one round trip.
      when 'sessionBundle' then (select jsonb_build_object(
          'session', s.data,
          'account', (select a.data from cumulus_id.cid_accounts a where a.cid = s.cid),
          'grants', coalesce((select jsonb_agg(g.data order by g.seq) from cumulus_id.cid_grants g where g.cid = s.cid), '[]'))
        from cumulus_id.cid_sessions s where s.token_hash = o->>'tokenHash')
      when 'sessionsOf' then coalesce((select jsonb_agg(data order by seq) from cumulus_id.cid_sessions where cid = o->>'cid'), '[]')
      when 'grant' then (select data from cumulus_id.cid_grants where cid = o->>'cid' and app = o->>'app')
      when 'grantsOf' then coalesce((select jsonb_agg(data order by seq) from cumulus_id.cid_grants where cid = o->>'cid'), '[]')
      when 'org' then (select data from cumulus_id.cid_orgs where id = o->>'id')
      when 'oneTime' then (select data from cumulus_id.cid_pending where kind = o->>'kind' and key = o->>'key')
      else null
    end;
    if o->>'op' not in ('account', 'cidForUsername', 'accountsInOrg', 'allAccounts', 'cidForIdentity', 'cidForFederation',
        'authenticator', 'authenticatorByCredential', 'authenticatorsOf', 'session', 'sessionByTokenHash', 'sessionBundle', 'sessionsOf',
        'grant', 'grantsOf', 'org', 'oneTime') then
      raise exception 'cid_read: unknown op %', o->>'op';
    end if;
    out := out || jsonb_build_array(coalesce(r, 'null'::jsonb));
  end loop;
  return out;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Writes, applied inside nexus_commit_cid. Each op: { "op", "key" fields, "data" (new value or null
-- to delete), "expect" (the value the request read, null for "didn't exist"; absent = don't check) }.
create or replace function cumulus_id.apply(o jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  cur jsonb;
  checked boolean := o ? 'expect';
  want jsonb := o->'expect';
  d jsonb := o->'data';
  n int;
begin
  -- The row a write checks must be the row it writes: refuse an op whose data names another key.
  if d is not null and d <> 'null'::jsonb and o->>'kind' in ('account', 'authenticator', 'session', 'grant', 'org') then
    if (o->>'kind' = 'account' and d->>'cid' is distinct from o->>'id')
      or (o->>'kind' in ('authenticator', 'session', 'org') and d->>'id' is distinct from o->>'id')
      or (o->>'kind' = 'grant' and (d->>'cid') || '|' || (d->>'app') is distinct from o->>'id') then
      raise exception 'cid write: % % does not match its data', o->>'kind', o->>'id';
    end if;
  end if;
  case o->>'kind'
    when 'account' then
      select data into cur from cumulus_id.cid_accounts where cid = o->>'id' for update;
      if checked and cur is distinct from nullif(want, 'null'::jsonb) then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      if d is null or d = 'null'::jsonb then
        delete from cumulus_id.cid_accounts where cid = o->>'id';
      else
        insert into cumulus_id.cid_accounts (cid, username, org_id, data) values (d->>'cid', d->>'username', d->>'orgId', d)
          on conflict (cid) do update set username = excluded.username, org_id = excluded.org_id, data = excluded.data;
      end if;
    when 'identity', 'federation' then
      if o->>'kind' = 'identity' then
        select to_jsonb(cid) into cur from cumulus_id.cid_identities where key = o->>'id' for update;
      else
        select to_jsonb(cid) into cur from cumulus_id.cid_federation where key = o->>'id' for update;
      end if;
      if checked and cur is distinct from nullif(want, 'null'::jsonb) then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      if o->>'kind' = 'identity' then
        if d is null or d = 'null'::jsonb then delete from cumulus_id.cid_identities where key = o->>'id';
        else insert into cumulus_id.cid_identities (key, cid) values (o->>'id', d #>> '{}') on conflict (key) do update set cid = excluded.cid; end if;
      else
        if d is null or d = 'null'::jsonb then delete from cumulus_id.cid_federation where key = o->>'id';
        else insert into cumulus_id.cid_federation (key, cid) values (o->>'id', d #>> '{}') on conflict (key) do update set cid = excluded.cid; end if;
      end if;
    when 'authenticator' then
      select data into cur from cumulus_id.cid_authenticators where id = o->>'id' for update;
      if checked and cur is distinct from nullif(want, 'null'::jsonb) then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      if d is null or d = 'null'::jsonb then
        delete from cumulus_id.cid_authenticators where id = o->>'id';
      else
        insert into cumulus_id.cid_authenticators (id, cid, credential_id, data) values (d->>'id', d->>'cid', d->>'credentialId', d)
          on conflict (id) do update set cid = excluded.cid, credential_id = excluded.credential_id, data = excluded.data;
      end if;
    when 'session' then
      select data into cur from cumulus_id.cid_sessions where id = o->>'id' for update;
      if checked and cur is distinct from nullif(want, 'null'::jsonb) then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      if d is null or d = 'null'::jsonb then
        delete from cumulus_id.cid_sessions where id = o->>'id';
      else
        insert into cumulus_id.cid_sessions (id, cid, token_hash, data) values (d->>'id', d->>'cid', d->>'tokenHash', d)
          on conflict (id) do update set cid = excluded.cid, token_hash = excluded.token_hash, data = excluded.data;
      end if;
    when 'grant' then
      select data into cur from cumulus_id.cid_grants where cid = split_part(o->>'id', '|', 1) and app = substr(o->>'id', length(split_part(o->>'id', '|', 1)) + 2) for update;
      if checked and cur is distinct from nullif(want, 'null'::jsonb) then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      if d is null or d = 'null'::jsonb then
        delete from cumulus_id.cid_grants where cid = split_part(o->>'id', '|', 1) and app = substr(o->>'id', length(split_part(o->>'id', '|', 1)) + 2);
      else
        insert into cumulus_id.cid_grants (cid, app, data) values (d->>'cid', d->>'app', d)
          on conflict (cid, app) do update set data = excluded.data;
      end if;
    when 'org' then
      select data into cur from cumulus_id.cid_orgs where id = o->>'id' for update;
      if checked and cur is distinct from nullif(want, 'null'::jsonb) then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      if d is null or d = 'null'::jsonb then delete from cumulus_id.cid_orgs where id = o->>'id';
      else insert into cumulus_id.cid_orgs (id, data) values (d->>'id', d) on conflict (id) do update set data = excluded.data; end if;
    when 'oneTime' then
      select data into cur from cumulus_id.cid_pending where kind = split_part(o->>'id', '|', 1) and key = substr(o->>'id', length(split_part(o->>'id', '|', 1)) + 2) for update;
      if checked and cur is distinct from nullif(want, 'null'::jsonb) then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      if d is null or d = 'null'::jsonb then
        delete from cumulus_id.cid_pending where kind = split_part(o->>'id', '|', 1) and key = substr(o->>'id', length(split_part(o->>'id', '|', 1)) + 2);
      else
        insert into cumulus_id.cid_pending (kind, key, expires_at, data)
          values (split_part(o->>'id', '|', 1), substr(o->>'id', length(split_part(o->>'id', '|', 1)) + 2), floor((d->>'expiresAt')::numeric)::bigint, d)
          on conflict (kind, key) do update set expires_at = excluded.expires_at, data = excluded.data;
      end if;
    when 'sweep' then
      delete from cumulus_id.cid_pending where kind = o->>'id' and expires_at < (o->>'now')::bigint;
    else
      raise exception 'cid write: unknown kind %', o->>'kind';
  end case;
exception when unique_violation then
  -- Another server took the same username, credential or token first: re-run the request.
  raise exception 'nexus_conflict' using errcode = 'P0001';
end $$;

-- nexus_commit plus the request's ID writes, all or nothing.
create or replace function public.nexus_commit_cid(p_entries jsonb, p_docs jsonb, p_cid jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  result jsonb;
  o jsonb;
begin
  result := public.nexus_commit(p_entries, p_docs);
  for o in select value from jsonb_array_elements(coalesce(p_cid, '[]'::jsonb)) loop
    perform cumulus_id.apply(o);
  end loop;
  return result;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Backfill: replace the rows with the `cid` document's contents, in one transaction.
-- Single-use items are not copied. The document itself is untouched.
create or replace function cumulus_id.refresh_from_document() returns jsonb
language plpgsql set search_path = '' as $$
declare
  d jsonb;
begin
  select data into d from public.nexus_docs where id = 'cid' for share;
  if d is null then raise exception 'nexus_docs has no cid row'; end if;
  truncate cumulus_id.cid_accounts, cumulus_id.cid_identities, cumulus_id.cid_federation, cumulus_id.cid_authenticators,
           cumulus_id.cid_sessions, cumulus_id.cid_grants, cumulus_id.cid_orgs;
  insert into cumulus_id.cid_orgs (id, data)
    select e->>0, e->1 from jsonb_array_elements(coalesce(d->'orgs'->'__map', '[]')) with ordinality as t(e, n) order by n;
  insert into cumulus_id.cid_accounts (cid, username, org_id, data)
    select e->1->>'cid', e->1->>'username', e->1->>'orgId', e->1 from jsonb_array_elements(coalesce(d->'accounts'->'__map', '[]')) with ordinality as t(e, n) order by n;
  insert into cumulus_id.cid_identities (key, cid)
    select e->>0, e->>1 from jsonb_array_elements(coalesce(d->'byIdentity'->'__map', '[]')) as t(e);
  insert into cumulus_id.cid_federation (key, cid)
    select e->>0, e->>1 from jsonb_array_elements(coalesce(d->'byFederation'->'__map', '[]')) as t(e);
  insert into cumulus_id.cid_authenticators (id, cid, credential_id, data)
    select e->1->>'id', e->1->>'cid', e->1->>'credentialId', e->1 from jsonb_array_elements(coalesce(d->'authenticators'->'__map', '[]')) with ordinality as t(e, n) order by n;
  insert into cumulus_id.cid_sessions (id, cid, token_hash, data)
    select e->1->>'id', e->1->>'cid', e->1->>'tokenHash', e->1 from jsonb_array_elements(coalesce(d->'sessions'->'__map', '[]')) with ordinality as t(e, n) order by n;
  insert into cumulus_id.cid_grants (cid, app, data)
    select e->1->>'cid', e->1->>'app', e->1 from jsonb_array_elements(coalesce(d->'grants'->'__map', '[]')) with ordinality as t(e, n) order by n;
  return jsonb_build_object(
    'accounts', (select count(*) from cumulus_id.cid_accounts),
    'authenticators', (select count(*) from cumulus_id.cid_authenticators),
    'sessions', (select count(*) from cumulus_id.cid_sessions),
    'grants', (select count(*) from cumulus_id.cid_grants),
    'identities', (select count(*) from cumulus_id.cid_identities),
    'federation', (select count(*) from cumulus_id.cid_federation),
    'orgs', (select count(*) from cumulus_id.cid_orgs));
end $$;

-- Only the service role (the nexus-store edge function) may call any of this.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema cumulus_id from anon, authenticated';
    execute 'revoke all on all tables in schema cumulus_id from anon, authenticated';
    execute 'revoke all on all sequences in schema cumulus_id from anon, authenticated';
    execute 'alter default privileges in schema cumulus_id revoke all on tables from anon, authenticated';
    execute 'revoke execute on function public.cid_read(jsonb) from anon, authenticated';
    execute 'revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.cid_read(jsonb) to service_role';
    execute 'grant execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) to service_role';
  end if;
end $$;
revoke all on schema cumulus_id from public;
revoke execute on function public.cid_read(jsonb) from public;
revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from public;
revoke execute on function cumulus_id.apply(jsonb) from public;
revoke execute on function cumulus_id.refresh_from_document() from public;
