-- Rows that take over from their documents by themselves. Until now a switch to rows needed a person
-- to run the refresh functions right before the deploy went live; otherwise accounts or mail written
-- to the documents after the last refresh were missing from the rows. Now a host in gateway mode sends
-- a `claim` for each kind of data it keeps as rows with its first commit, and the database copies
-- that document into the rows exactly once, under a lock, and remembers it: later claims (every cold
-- start, every other server) do nothing, so rows the hosts wrote since are never replaced.
--
--   select * from cumulus_rows.claims;                    -- what has been handed over, and when
--   delete from cumulus_rows.claims where product = 'mail'; -- only to copy that document in again
--
-- Products: 'cid' (Cumulus://ID), 'mail', 'wallet', 'quota'. Builds on 20261113–20261120.

create table if not exists cumulus_rows.claims (
  product text primary key check (product in ('cid', 'mail', 'wallet', 'quota')),
  claimed_at timestamptz not null default now(),
  document_version bigint,
  copied jsonb not null
);
alter table cumulus_rows.claims enable row level security;

-- The wallet and quota halves of refresh_from_documents(), so each can be claimed on its own.
create or replace function cumulus_rows.refresh_wallet_from_document() returns jsonb
language plpgsql set search_path = '' as $$
declare
  w jsonb;
begin
  select data into w from public.nexus_docs where id = 'firm-wallet' for share;
  truncate cumulus_rows.wallet_accounts, cumulus_rows.wallet_transfers;
  insert into cumulus_rows.wallet_accounts (cid, address, data)
    select e->1->>'cid', lower(e->1->>'address'), e->1 from jsonb_array_elements(coalesce(w->'accounts'->'__map', '[]')) with ordinality as t(e, n) order by n;
  insert into cumulus_rows.wallet_transfers (id, from_cid, to_cid, at, data)
    select e->1->>'id', e->1->>'from', e->1->>'to', e->1->>'at', e->1 from jsonb_array_elements(coalesce(w->'transfers'->'__map', '[]')) as t(e);
  return jsonb_build_object('wallets', (select count(*) from cumulus_rows.wallet_accounts), 'transfers', (select count(*) from cumulus_rows.wallet_transfers));
end $$;

create or replace function cumulus_rows.refresh_quota_from_document() returns jsonb
language plpgsql set search_path = '' as $$
declare
  q jsonb;
begin
  select data into q from public.nexus_docs where id = 'cumulus-quota' for share;
  truncate cumulus_rows.quota_usage;
  insert into cumulus_rows.quota_usage (cid, mail_bytes, cloud_bytes, extra_gb)
    select k, coalesce((u->>'mail')::numeric, 0)::bigint, coalesce((u->>'cloud')::numeric, 0)::bigint,
           coalesce((select (x->>1)::numeric from jsonb_array_elements(coalesce(q->'extraGb'->'__map', '[]')) x where x->>0 = k), 0)
    from (select e->>0 as k, e->1 as u from jsonb_array_elements(coalesce(q->'usage'->'__map', '[]')) e) t;
  insert into cumulus_rows.quota_usage (cid, extra_gb)
    select x->>0, (x->>1)::numeric from jsonb_array_elements(coalesce(q->'extraGb'->'__map', '[]')) x
    on conflict (cid) do nothing;
  return jsonb_build_object('quotas', (select count(*) from cumulus_rows.quota_usage));
end $$;

create or replace function cumulus_rows.refresh_from_documents() returns jsonb
language plpgsql set search_path = '' as $$
begin
  return cumulus_rows.refresh_wallet_from_document() || cumulus_rows.refresh_quota_from_document();
end $$;

-- Hand one document over to its rows, once. Returns what was copied, or {"already": true}.
create or replace function cumulus_rows.claim(p_product text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  doc_id text := case p_product when 'cid' then 'cid' when 'mail' then 'cumulus-mail' when 'wallet' then 'firm-wallet' when 'quota' then 'cumulus-quota' end;
  v bigint;
  copied jsonb := '{}'::jsonb;
begin
  if doc_id is null then raise exception 'claim: unknown product %', p_product; end if;
  perform pg_advisory_xact_lock(hashtext('cumulus_rows.claim|' || p_product));
  if exists (select 1 from cumulus_rows.claims where product = p_product) then return jsonb_build_object('already', true); end if;
  select version into v from public.nexus_docs where id = doc_id;
  if v is not null then
    copied := case p_product
      when 'cid' then cumulus_id.refresh_from_document()
      when 'mail' then cumulus_rows.refresh_mail_from_document()
      when 'wallet' then cumulus_rows.refresh_wallet_from_document()
      else cumulus_rows.refresh_quota_from_document()
    end;
  end if;
  insert into cumulus_rows.claims (product, document_version, copied) values (p_product, v, copied);
  return jsonb_build_object('claimed', true, 'documentVersion', v, 'copied', copied);
end $$;

create or replace function public.nexus_commit_cid(p_entries jsonb, p_docs jsonb, p_cid jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  result jsonb;
  o jsonb;
begin
  result := public.nexus_commit(p_entries, p_docs);
  -- Claims first: a host's first commit hands the documents' contents to the rows, once.
  for o in select value from jsonb_array_elements(coalesce(p_cid, '[]'::jsonb)) where value->>'kind' = 'claim' loop
    result := result || jsonb_build_object('claim:' || (o->>'id'), cumulus_rows.claim(o->>'id'));
  end loop;
  -- One order for every request (by kind, then key; a key's own writes keep their order), so two
  -- requests writing the same rows take their locks in the same order and can't deadlock.
  for o in select value from jsonb_array_elements(coalesce(p_cid, '[]'::jsonb)) with ordinality as t(value, n)
           where value->>'kind' <> 'claim'
           order by value->>'kind', value->>'id', n loop
    if o->>'kind' in ('wallet', 'transfer', 'quota', 'mailbox', 'message', 'messageDelete', 'mailAddress', 'outbound') then perform cumulus_rows.apply(o);
    else perform cumulus_id.apply(o); end if;
  end loop;
  return result;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on cumulus_rows.claims from anon, authenticated';
    execute 'revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) to service_role';
  end if;
end $$;
revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from public;
revoke execute on function cumulus_rows.claim(text) from public;
revoke execute on function cumulus_rows.refresh_wallet_from_document() from public;
revoke execute on function cumulus_rows.refresh_quota_from_document() from public;
revoke execute on function cumulus_rows.refresh_from_documents() from public;
