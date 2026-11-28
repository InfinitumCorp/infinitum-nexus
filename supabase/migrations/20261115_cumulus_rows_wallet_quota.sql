-- FIRM Wallet and the storage quota as rows behind nexus-store (CUMULUS_ROWS=wallet,quota with
-- CUMULUS_STORE=gateway; relational storage plan, phase 5).
--
-- Same tables as packages/firm walletSchemaSql and packages/cloud quotaSchemaSql, in schema cumulus_rows
-- (not exposed by the Data API; RLS on with no policies; no grants to public roles). They travel through
-- the calls hosts already make, so the nexus-store edge function doesn't change:
--   public.cid_read(p_ops)          also answers walletAccount, walletByAddress, transfersOf, quotaUsage
--   public.nexus_commit_cid(...)    also applies kinds wallet, transfer and quota, in the same
--                                   transaction as the ledger; every write carries the value the request
--                                   read, and a row changed since raises nexus_conflict (the request
--                                   re-runs), so a balance can't be spent twice by two servers
--   cumulus_rows.refresh_from_documents()   copies the firm-wallet and cumulus-quota documents in

create schema if not exists cumulus_rows;

create table if not exists cumulus_rows.wallet_accounts (
  seq bigserial,
  cid text primary key,
  address text not null unique,
  data jsonb not null
);
create table if not exists cumulus_rows.wallet_transfers (
  id text primary key,
  from_cid text,
  to_cid text not null,
  at text not null,
  data jsonb not null
);
create index if not exists wallet_transfers_from on cumulus_rows.wallet_transfers (from_cid, at desc) where from_cid is not null;
create index if not exists wallet_transfers_to on cumulus_rows.wallet_transfers (to_cid, at desc);
create table if not exists cumulus_rows.quota_usage (
  cid text primary key,
  mail_bytes bigint not null default 0 check (mail_bytes >= 0),
  cloud_bytes bigint not null default 0 check (cloud_bytes >= 0),
  extra_gb numeric not null default 0 check (extra_gb >= 0)
);
alter table cumulus_rows.wallet_accounts enable row level security;
alter table cumulus_rows.wallet_transfers enable row level security;
alter table cumulus_rows.quota_usage enable row level security;

-- One lookup. A quota row reads as { mail, cloud, extraGb }.
create or replace function cumulus_rows.read_one(o jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  case o->>'op'
    when 'walletAccount' then return (select data from cumulus_rows.wallet_accounts where cid = o->>'cid');
    when 'walletByAddress' then return (select to_jsonb(cid) from cumulus_rows.wallet_accounts where address = lower(o->>'address'));
    when 'transfersOf' then return coalesce((select jsonb_agg(data order by at desc, id desc) from (
        select data, at, id from cumulus_rows.wallet_transfers where from_cid = o->>'cid' or to_cid = o->>'cid'
        order by at desc, id desc limit least(greatest(coalesce((o->>'limit')::int, 50), 0), 500)) t), '[]');
    when 'quotaUsage' then return (select jsonb_build_object('mail', mail_bytes, 'cloud', cloud_bytes, 'extraGb', extra_gb) from cumulus_rows.quota_usage where cid = o->>'cid');
    else raise exception 'cid_read: unknown op %', o->>'op';
  end case;
end $$;

-- One write. Each op: { kind, id, data (null deletes), expect (the value read; absent = not checked) }.
create or replace function cumulus_rows.apply(o jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  cur jsonb;
  checked boolean := o ? 'expect';
  want jsonb := nullif(o->'expect', 'null'::jsonb);
  d jsonb := nullif(o->'data', 'null'::jsonb);
begin
  -- Two servers writing the same key wait for each other here, so a write that expects a row not to
  -- exist yet sees one another server has just created (and conflicts) instead of overwriting it.
  perform pg_advisory_xact_lock(hashtext('cumulus_rows.' || coalesce(o->>'kind', '') || '|' || coalesce(o->>'id', '')));
  case o->>'kind'
    when 'wallet' then
      if d is not null and d->>'cid' is distinct from o->>'id' then raise exception 'rows write: wallet % does not match its data', o->>'id'; end if;
      select data into cur from cumulus_rows.wallet_accounts where cid = o->>'id' for update;
      if checked and cur is distinct from want then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      if d is null then delete from cumulus_rows.wallet_accounts where cid = o->>'id';
      else insert into cumulus_rows.wallet_accounts (cid, address, data) values (d->>'cid', lower(d->>'address'), d)
        on conflict (cid) do update set address = excluded.address, data = excluded.data; end if;
    when 'transfer' then
      if d is null or d->>'id' is distinct from o->>'id' then raise exception 'rows write: transfer % does not match its data', o->>'id'; end if;
      select data into cur from cumulus_rows.wallet_transfers where id = o->>'id' for update;
      if checked and cur is distinct from want then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      insert into cumulus_rows.wallet_transfers (id, from_cid, to_cid, at, data) values (d->>'id', d->>'from', d->>'to', d->>'at', d)
        on conflict (id) do update set data = excluded.data;
    when 'quota' then
      select jsonb_build_object('mail', mail_bytes, 'cloud', cloud_bytes, 'extraGb', extra_gb) into cur from cumulus_rows.quota_usage where cid = o->>'id' for update;
      if checked and cur is distinct from want then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      if d is null then delete from cumulus_rows.quota_usage where cid = o->>'id';
      else insert into cumulus_rows.quota_usage (cid, mail_bytes, cloud_bytes, extra_gb)
          values (o->>'id', round((d->>'mail')::numeric)::bigint, round((d->>'cloud')::numeric)::bigint, greatest(coalesce((d->>'extraGb')::numeric, 0), 0))
          on conflict (cid) do update set mail_bytes = excluded.mail_bytes, cloud_bytes = excluded.cloud_bytes, extra_gb = excluded.extra_gb; end if;
    else raise exception 'rows write: unknown kind %', o->>'kind';
  end case;
exception when unique_violation then
  -- Another server took the same wallet address first: re-run the request.
  raise exception 'nexus_conflict' using errcode = 'P0001';
end $$;

-- Cumulus://ID writes, as in 20261113_cumulus_id_rows.sql plus the same per-key lock: before it, two
-- servers creating the same grant or sign-in link at once could both pass the "doesn't exist yet" check.
create or replace function cumulus_id.apply(o jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  cur jsonb;
  checked boolean := o ? 'expect';
  want jsonb := o->'expect';
  d jsonb := o->'data';
  n int;
begin
  -- Two servers writing the same key wait for each other here, so a write that expects a row not to
  -- exist yet sees one another server has just created (and conflicts) instead of overwriting it.
  perform pg_advisory_xact_lock(hashtext('cumulus_id.' || coalesce(o->>'kind', '') || '|' || coalesce(o->>'id', '')));
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

-- Lookups: Cumulus://ID's as before, then the wallet and quota ones.
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
      r := cumulus_rows.read_one(o); -- FIRM Wallet and quota lookups; raises on an unknown op
    end if;
    out := out || jsonb_build_array(coalesce(r, 'null'::jsonb));
  end loop;
  return out;
end $$;

-- nexus_commit plus the request's row writes (ID, wallet, quota), all or nothing.
create or replace function public.nexus_commit_cid(p_entries jsonb, p_docs jsonb, p_cid jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  result jsonb;
  o jsonb;
begin
  result := public.nexus_commit(p_entries, p_docs);
  for o in select value from jsonb_array_elements(coalesce(p_cid, '[]'::jsonb)) loop
    if o->>'kind' in ('wallet', 'transfer', 'quota') then perform cumulus_rows.apply(o);
    else perform cumulus_id.apply(o); end if;
  end loop;
  return result;
end $$;

-- Backfill: replace the wallet and quota rows with the documents' contents, in one transaction.
create or replace function cumulus_rows.refresh_from_documents() returns jsonb
language plpgsql set search_path = '' as $$
declare
  w jsonb;
  q jsonb;
begin
  select data into w from public.nexus_docs where id = 'firm-wallet' for share;
  select data into q from public.nexus_docs where id = 'cumulus-quota' for share;
  truncate cumulus_rows.wallet_accounts, cumulus_rows.wallet_transfers, cumulus_rows.quota_usage;
  insert into cumulus_rows.wallet_accounts (cid, address, data)
    select e->1->>'cid', lower(e->1->>'address'), e->1 from jsonb_array_elements(coalesce(w->'accounts'->'__map', '[]')) with ordinality as t(e, n) order by n;
  insert into cumulus_rows.wallet_transfers (id, from_cid, to_cid, at, data)
    select e->1->>'id', e->1->>'from', e->1->>'to', e->1->>'at', e->1 from jsonb_array_elements(coalesce(w->'transfers'->'__map', '[]')) as t(e);
  insert into cumulus_rows.quota_usage (cid, mail_bytes, cloud_bytes, extra_gb)
    select k, coalesce((u->>'mail')::numeric, 0)::bigint, coalesce((u->>'cloud')::numeric, 0)::bigint,
           coalesce((select (x->>1)::numeric from jsonb_array_elements(coalesce(q->'extraGb'->'__map', '[]')) x where x->>0 = k), 0)
    from (select e->>0 as k, e->1 as u from jsonb_array_elements(coalesce(q->'usage'->'__map', '[]')) e) t;
  insert into cumulus_rows.quota_usage (cid, extra_gb)
    select x->>0, (x->>1)::numeric from jsonb_array_elements(coalesce(q->'extraGb'->'__map', '[]')) x
    on conflict (cid) do nothing;
  return jsonb_build_object(
    'wallets', (select count(*) from cumulus_rows.wallet_accounts),
    'transfers', (select count(*) from cumulus_rows.wallet_transfers),
    'quotas', (select count(*) from cumulus_rows.quota_usage));
end $$;

-- Only the service role (the nexus-store edge function) may call any of this.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema cumulus_rows from anon, authenticated';
    execute 'revoke all on all tables in schema cumulus_rows from anon, authenticated';
    execute 'revoke all on all sequences in schema cumulus_rows from anon, authenticated';
    execute 'alter default privileges in schema cumulus_rows revoke all on tables from anon, authenticated';
    execute 'revoke execute on function public.cid_read(jsonb) from anon, authenticated';
    execute 'revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.cid_read(jsonb) to service_role';
    execute 'grant execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) to service_role';
  end if;
end $$;
revoke all on schema cumulus_rows from public;
revoke execute on function public.cid_read(jsonb) from public;
revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from public;
revoke execute on function cumulus_rows.read_one(jsonb) from public;
revoke execute on function cumulus_rows.apply(jsonb) from public;
revoke execute on function cumulus_rows.refresh_from_documents() from public;
