-- Cumulus://Drive metadata as rows behind nexus-store (CUMULUS_ROWS=drive with CUMULUS_STORE=gateway;
-- relational storage plan, phase 5). Builds on 20261121_cumulus_rows_claim.sql: the same lookups
-- (public.cid_read), the same commit (public.nexus_commit_cid) and the same first-request claim, so the
-- edge function doesn't change.
--
-- One row per Drive item (folder, document or file: owner, folder and who it's shared with as columns,
-- the item as JSON) and one per person who has opened Drive. Each item write carries the item as the
-- request read it; if another server changed it since, the commit raises nexus_conflict and the request
-- re-runs, so two saves of the same document can't both win. File contents stay in object storage.

create table if not exists cumulus_rows.drive_items (
  id text primary key,
  owner text not null,
  parent text,
  shared_with text[] not null default '{}',
  data jsonb not null
);
create index if not exists drive_items_owner on cumulus_rows.drive_items (owner);
create index if not exists drive_items_parent on cumulus_rows.drive_items (parent) where parent is not null;
create index if not exists drive_items_shared on cumulus_rows.drive_items using gin (shared_with);
create table if not exists cumulus_rows.drive_enabled (
  cid text primary key,
  at text not null
);
-- Claims can now be for Drive too.
alter table cumulus_rows.claims drop constraint if exists claims_product_check;
alter table cumulus_rows.claims add constraint claims_product_check check (product in ('cid', 'mail', 'wallet', 'quota', 'drive'));
alter table cumulus_rows.drive_items enable row level security;
alter table cumulus_rows.drive_enabled enable row level security;

create or replace function cumulus_rows.drive_read(o jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  case o->>'op'
    when 'driveItem' then return (select data from cumulus_rows.drive_items where id = o->>'id');
    when 'driveItemsOf' then return coalesce((select jsonb_agg(data order by id) from cumulus_rows.drive_items where owner = o->>'owner'), '[]');
    when 'driveChildren' then return coalesce((select jsonb_agg(data order by id) from cumulus_rows.drive_items where parent = o->>'parent'), '[]');
    when 'driveSharedWith' then return coalesce((select jsonb_agg(data order by id) from cumulus_rows.drive_items where shared_with @> array[o->>'cid']), '[]');
    when 'driveEnabled' then return (select to_jsonb(at) from cumulus_rows.drive_enabled where cid = o->>'cid');
    else raise exception 'cid_read: unknown op %', o->>'op';
  end case;
end $$;

-- driveItem: data null deletes. expect present: the item as read (null: must not exist yet).
-- driveEnabled: the first time wins (a later write for the same person changes nothing).
create or replace function cumulus_rows.drive_apply(o jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  cur jsonb;
  checked boolean := o ? 'expect';
  want jsonb := nullif(o->'expect', 'null'::jsonb);
  d jsonb := nullif(o->'data', 'null'::jsonb);
begin
  perform pg_advisory_xact_lock(hashtext('cumulus_rows.' || coalesce(o->>'kind', '') || '|' || coalesce(o->>'id', '')));
  case o->>'kind'
    when 'driveItem' then
      if d is not null and d->>'id' is distinct from o->>'id' then raise exception 'rows write: drive item % does not match its data', o->>'id'; end if;
      select data into cur from cumulus_rows.drive_items where id = o->>'id' for update;
      if checked and cur is distinct from want then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      if d is null then delete from cumulus_rows.drive_items where id = o->>'id';
      else insert into cumulus_rows.drive_items (id, owner, parent, shared_with, data)
          values (o->>'id', d->>'owner', d->>'parent', coalesce(array(select jsonb_array_elements_text(d->'sharedWith')), '{}'), d)
          on conflict (id) do update set owner = excluded.owner, parent = excluded.parent, shared_with = excluded.shared_with, data = excluded.data; end if;
    when 'driveEnabled' then
      if jsonb_typeof(o->'data') <> 'string' then raise exception 'rows write: driveEnabled % needs a time', o->>'id'; end if;
      insert into cumulus_rows.drive_enabled (cid, at) values (o->>'id', o->>'data') on conflict (cid) do nothing;
    else raise exception 'rows write: unknown kind %', o->>'kind';
  end case;
end $$;

-- The lookups of 20261116 plus Drive's.
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
    when 'mailbox', 'mailboxCids', 'mailAddress', 'mailOutbound', 'mailOpenOutbound', 'mailDueOutbound' then return cumulus_rows.mail_read(o);
    when 'driveItem', 'driveItemsOf', 'driveChildren', 'driveSharedWith', 'driveEnabled' then return cumulus_rows.drive_read(o);
    else raise exception 'cid_read: unknown op %', o->>'op';
  end case;
end $$;

-- Backfill for Drive: replace the Drive rows with the cumulus-workspace document's contents.
create or replace function cumulus_rows.refresh_drive_from_document() returns jsonb
language plpgsql set search_path = '' as $$
declare
  w jsonb;
begin
  select data into w from public.nexus_docs where id = 'cumulus-workspace' for share;
  truncate cumulus_rows.drive_items, cumulus_rows.drive_enabled;
  if w is null then return jsonb_build_object('items', 0, 'enabled', 0); end if;
  insert into cumulus_rows.drive_items (id, owner, parent, shared_with, data)
    select e->1->>'id', e->1->>'owner', e->1->>'parent', coalesce(array(select jsonb_array_elements_text(e->1->'sharedWith')), '{}'), e->1
    from jsonb_array_elements(coalesce(w->'items'->'__map', '[]')) as t(e);
  insert into cumulus_rows.drive_enabled (cid, at)
    select e->>0, e->>1 from jsonb_array_elements(coalesce(w->'enabled'->'__map', '[]')) as t(e);
  return jsonb_build_object(
    'items', (select count(*) from cumulus_rows.drive_items),
    'enabled', (select count(*) from cumulus_rows.drive_enabled));
end $$;

-- How far the Drive rows are from the cumulus-workspace document (read-only; before new writes, after a
-- claim, it should say {"same": true}): select cumulus_rows.compare_drive_with_document();
create or replace function cumulus_rows.compare_drive_with_document() returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  w jsonb;
  docs jsonb;
  rows jsonb;
  diff jsonb := '{}'::jsonb;
  counts jsonb := '{}'::jsonb;
  k text;
begin
  select data into w from public.nexus_docs where id = 'cumulus-workspace';
  if w is null then return jsonb_build_object('same', true, 'document', false); end if;
  for k in select unnest(array['items', 'enabled']) loop
    if k = 'items' then
      docs := coalesce((select jsonb_object_agg(e->>0, e->1) from jsonb_array_elements(coalesce(w->'items'->'__map', '[]')) e), '{}');
      rows := coalesce((select jsonb_object_agg(id, data) from cumulus_rows.drive_items), '{}');
    else
      docs := coalesce((select jsonb_object_agg(e->>0, e->1) from jsonb_array_elements(coalesce(w->'enabled'->'__map', '[]')) e), '{}');
      rows := coalesce((select jsonb_object_agg(cid, to_jsonb(at)) from cumulus_rows.drive_enabled), '{}');
    end if;
    counts := counts || jsonb_build_object(k, jsonb_build_object('document', (select count(*) from jsonb_object_keys(docs)), 'rows', (select count(*) from jsonb_object_keys(rows))));
    if exists (select 1 from jsonb_object_keys(docs) key where not rows ? key or rows->key <> docs->key)
       or exists (select 1 from jsonb_object_keys(rows) key where not docs ? key) then
      diff := diff || jsonb_build_object(k, jsonb_build_object(
        'onlyInDocument', coalesce((select jsonb_agg(key) from (select key from jsonb_object_keys(docs) key where not rows ? key limit 20) t), '[]'),
        'onlyInRows', coalesce((select jsonb_agg(key) from (select key from jsonb_object_keys(rows) key where not docs ? key limit 20) t), '[]'),
        'changed', coalesce((select jsonb_agg(key) from (select key from jsonb_object_keys(docs) key where rows ? key and rows->key <> docs->key limit 20) t), '[]')));
    end if;
  end loop;
  return jsonb_build_object('same', diff = '{}'::jsonb, 'counts', counts)
    || case when diff = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('differences', diff) end;
end $$;

-- Rollback: rebuild the cumulus-workspace document from the rows, so Drive changes made since the switch
-- aren't lost. Write it back (version + 1, so running servers reload it), then remove drive from
-- CUMULUS_ROWS and deploy:
--   select cumulus_rows.drive_document_from_rows();   -- read-only, the document as JSON
--   select cumulus_rows.restore_drive_document();
-- The Drive claim is forgotten too, so a later switch to rows copies the document again.
create or replace function cumulus_rows.drive_document_from_rows() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'items', jsonb_build_object('__map', coalesce((select jsonb_agg(jsonb_build_array(id, data) order by id) from cumulus_rows.drive_items), '[]')),
    'enabled', jsonb_build_object('__map', coalesce((select jsonb_agg(jsonb_build_array(cid, to_jsonb(at)) order by cid) from cumulus_rows.drive_enabled), '[]')))
$$;

create or replace function cumulus_rows.restore_drive_document() returns jsonb
language plpgsql set search_path = '' as $$
declare
  d jsonb;
  v bigint;
begin
  -- Not while a claim runs, and no Drive write commits while the document is rebuilt (the share lock
  -- waits for writes in progress and holds new ones until this transaction ends).
  perform pg_advisory_xact_lock(hashtext('cumulus_rows.claim|drive'));
  lock table cumulus_rows.drive_items, cumulus_rows.drive_enabled in share mode;
  d := cumulus_rows.drive_document_from_rows();
  update public.nexus_docs set data = d, version = version + 1, updated_at = now() where id = 'cumulus-workspace' returning version into v;
  if v is null then
    insert into public.nexus_docs (id, version, data) values ('cumulus-workspace', 1, d);
    v := 1;
  end if;
  delete from cumulus_rows.claims where product = 'drive';
  return jsonb_build_object('version', v, 'items', jsonb_array_length(d->'items'->'__map'), 'enabled', jsonb_array_length(d->'enabled'->'__map'));
end $$;

-- 20261121's claim, with Drive.
create or replace function cumulus_rows.claim(p_product text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  doc_id text := case p_product when 'cid' then 'cid' when 'mail' then 'cumulus-mail' when 'wallet' then 'firm-wallet'
    when 'quota' then 'cumulus-quota' when 'drive' then 'cumulus-workspace' end;
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
      when 'drive' then cumulus_rows.refresh_drive_from_document()
      else cumulus_rows.refresh_quota_from_document()
    end;
  end if;
  insert into cumulus_rows.claims (product, document_version, copied) values (p_product, v, copied);
  return jsonb_build_object('claimed', true, 'documentVersion', v, 'copied', copied);
end $$;

-- 20261121's commit, with Drive's writes.
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
    elsif o->>'kind' in ('driveItem', 'driveEnabled') then perform cumulus_rows.drive_apply(o);
    else perform cumulus_id.apply(o); end if;
  end loop;
  return result;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on cumulus_rows.drive_items, cumulus_rows.drive_enabled from anon, authenticated';
    execute 'revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) to service_role';
  end if;
end $$;
revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from public;
revoke execute on function cumulus_rows.read_one(jsonb) from public;
revoke execute on function cumulus_rows.drive_read(jsonb) from public;
revoke execute on function cumulus_rows.drive_apply(jsonb) from public;
revoke execute on function cumulus_rows.refresh_drive_from_document() from public;
revoke execute on function cumulus_rows.compare_drive_with_document() from public;
revoke execute on function cumulus_rows.drive_document_from_rows() from public;
revoke execute on function cumulus_rows.restore_drive_document() from public;
revoke execute on function cumulus_rows.claim(text) from public;
