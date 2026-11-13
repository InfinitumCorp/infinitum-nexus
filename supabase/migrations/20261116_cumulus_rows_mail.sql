-- Cumulus://Mail as rows behind nexus-store (CUMULUS_ROWS=mail with CUMULUS_STORE=gateway; relational
-- storage plan, phase 5). Builds on 20261115_cumulus_rows_wallet_quota.sql: the same lookups
-- (public.cid_read) and the same commit (public.nexus_commit_cid), so the edge function doesn't change.
--
-- One row per mailbox (owner, aliases, tasks, contacts, Clean state, and a version), per message, per
-- address and per outbound job. A request that changes a mailbox writes it with the version it read and
-- the next one; if another server changed the mailbox since, the commit raises nexus_conflict and the
-- request re-runs, so two deliveries at once are both kept. Messages are written only when they changed.
-- Message content is stored as the host gives it: hosts with a mail master key seal it themselves
-- (CUMULUS_STORE=postgres); the gateway path is for hosts without one.

create table if not exists cumulus_rows.mail_mailboxes (
  cid text primary key,
  seq bigserial,
  version bigint not null,
  data jsonb not null
);
create table if not exists cumulus_rows.mail_messages (
  cid text not null,
  id text not null,
  ord bigint not null,
  folder text not null,
  thread_id text not null,
  at text not null,
  data jsonb not null,
  primary key (cid, id)
);
create index if not exists mail_messages_order on cumulus_rows.mail_messages (cid, ord desc);
create index if not exists mail_messages_folder on cumulus_rows.mail_messages (cid, folder, at desc);
create table if not exists cumulus_rows.mail_addresses (
  address text primary key check (address = lower(address)),
  cid text not null
);
create index if not exists mail_addresses_cid on cumulus_rows.mail_addresses (cid);
create table if not exists cumulus_rows.mail_outbound (
  id text primary key,
  seq bigserial,
  status text not null check (status in ('queued', 'sending', 'sent', 'failed')),
  data jsonb not null
);
create index if not exists mail_outbound_open on cumulus_rows.mail_outbound (seq) where status in ('queued', 'sending');
alter table cumulus_rows.mail_mailboxes enable row level security;
alter table cumulus_rows.mail_messages enable row level security;
alter table cumulus_rows.mail_addresses enable row level security;
alter table cumulus_rows.mail_outbound enable row level security;

-- Mail lookups. A mailbox reads as { version, data, messages: [{ id, ord, data }] } (newest first).
create or replace function cumulus_rows.mail_read(o jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  case o->>'op'
    when 'mailbox' then return (select jsonb_build_object('version', b.version, 'data', b.data, 'messages',
        coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'ord', m.ord, 'data', m.data) order by m.ord desc) from cumulus_rows.mail_messages m where m.cid = b.cid), '[]'))
      from cumulus_rows.mail_mailboxes b where b.cid = o->>'cid');
    when 'mailboxCids' then return coalesce((select jsonb_agg(cid order by seq) from cumulus_rows.mail_mailboxes), '[]');
    when 'mailAddress' then return (select to_jsonb(cid) from cumulus_rows.mail_addresses where address = lower(o->>'address'));
    when 'mailOutbound' then return (select data from cumulus_rows.mail_outbound where id = o->>'id');
    when 'mailOpenOutbound' then return coalesce((select jsonb_agg(data order by seq) from cumulus_rows.mail_outbound where status in ('queued', 'sending')), '[]');
    when 'mailDueOutbound' then return coalesce((select jsonb_agg(data order by seq) from (
        select data, seq from cumulus_rows.mail_outbound
        where (status = 'queued' and (data->>'nextAttemptAt' is null or (data->>'nextAttemptAt')::timestamptz <= (o->>'now')::timestamptz))
           or (status = 'sending' and (data->>'claimedAt')::timestamptz < (o->>'staleBefore')::timestamptz)
        order by seq limit least(greatest(coalesce((o->>'limit')::int, 20), 0), 200)) t), '[]');
    else raise exception 'cid_read: unknown op %', o->>'op';
  end case;
end $$;

-- Mail writes. Called from cumulus_rows.apply, after its per-key lock.
--   mailbox        { id: cid, data, version, expect: version read (null: new) }
--   message        { id: cid|messageId, data: { ord, folder, threadId, at, message } }
--   messageDelete  { id: cid|messageId }
--   mailAddress    { id: address, data: cid, expect: null }  (an address is never reassigned)
--   outbound       { id, data: job, expect: job as read (null: new) }
create or replace function cumulus_rows.mail_apply(o jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  cur jsonb;
  checked boolean := o ? 'expect';
  want jsonb := nullif(o->'expect', 'null'::jsonb);
  d jsonb := nullif(o->'data', 'null'::jsonb);
  owner text := split_part(o->>'id', '|', 1);
  mid text := substr(o->>'id', length(split_part(o->>'id', '|', 1)) + 2);
begin
  case o->>'kind'
    when 'mailbox' then
      if d is null or d->>'cid' is distinct from o->>'id' then raise exception 'rows write: mailbox % does not match its data', o->>'id'; end if;
      select to_jsonb(version) into cur from cumulus_rows.mail_mailboxes where cid = o->>'id' for update;
      if checked and cur is distinct from want then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      insert into cumulus_rows.mail_mailboxes (cid, version, data) values (o->>'id', (o->>'version')::bigint, d)
        on conflict (cid) do update set version = excluded.version, data = excluded.data;
    when 'message' then
      if d is null or d->'message'->>'id' is distinct from mid then raise exception 'rows write: message % does not match its data', o->>'id'; end if;
      insert into cumulus_rows.mail_messages (cid, id, ord, folder, thread_id, at, data)
        values (owner, mid, (d->>'ord')::bigint, d->'message'->>'folder', d->'message'->>'threadId', d->'message'->>'at', d->'message')
        on conflict (cid, id) do update set ord = excluded.ord, folder = excluded.folder, thread_id = excluded.thread_id, at = excluded.at, data = excluded.data;
    when 'messageDelete' then
      delete from cumulus_rows.mail_messages where cid = owner and id = mid;
    when 'mailAddress' then
      select to_jsonb(cid) into cur from cumulus_rows.mail_addresses where address = lower(o->>'id') for update;
      if cur is not null and cur is distinct from d then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      insert into cumulus_rows.mail_addresses (address, cid) values (lower(o->>'id'), d #>> '{}') on conflict (address) do nothing;
    when 'outbound' then
      if d is null or d->>'id' is distinct from o->>'id' then raise exception 'rows write: outbound % does not match its data', o->>'id'; end if;
      select data into cur from cumulus_rows.mail_outbound where id = o->>'id' for update;
      if checked and cur is distinct from want then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
      insert into cumulus_rows.mail_outbound (id, status, data) values (o->>'id', d->>'status', d)
        on conflict (id) do update set status = excluded.status, data = excluded.data;
    else raise exception 'rows write: unknown kind %', o->>'kind';
  end case;
end $$;

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
    else raise exception 'cid_read: unknown op %', o->>'op';
  end case;
end $$;

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
    when 'mailbox', 'message', 'messageDelete', 'mailAddress', 'outbound' then perform cumulus_rows.mail_apply(o);
    else raise exception 'rows write: unknown kind %', o->>'kind';
  end case;
exception when unique_violation then
  -- Another server took the same wallet address first: re-run the request.
  raise exception 'nexus_conflict' using errcode = 'P0001';
end $$;

create or replace function public.nexus_commit_cid(p_entries jsonb, p_docs jsonb, p_cid jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  result jsonb;
  o jsonb;
begin
  result := public.nexus_commit(p_entries, p_docs);
  for o in select value from jsonb_array_elements(coalesce(p_cid, '[]'::jsonb)) loop
    if o->>'kind' in ('wallet', 'transfer', 'quota', 'mailbox', 'message', 'messageDelete', 'mailAddress', 'outbound') then perform cumulus_rows.apply(o);
    else perform cumulus_id.apply(o); end if;
  end loop;
  return result;
end $$;

-- Backfill for mail: replace the mail rows with the cumulus-mail document's contents (the wallet and
-- quota ones stay as they are; cumulus_rows.refresh_from_documents() copies those). Unsealed documents
-- only, which is what hosts without a mail master key keep.
create or replace function cumulus_rows.refresh_mail_from_document() returns jsonb
language plpgsql set search_path = '' as $$
declare
  m jsonb;
begin
  select data into m from public.nexus_docs where id = 'cumulus-mail' for share;
  truncate cumulus_rows.mail_mailboxes, cumulus_rows.mail_messages, cumulus_rows.mail_addresses, cumulus_rows.mail_outbound;
  if m is null then return jsonb_build_object('mailboxes', 0); end if;
  insert into cumulus_rows.mail_mailboxes (cid, version, data)
    select e->>0, 1, (e->1) - 'messages' || jsonb_build_object('cid', e->>0)
    from jsonb_array_elements(coalesce(m->'mailboxes'->'__map', '[]')) with ordinality as t(e, n) order by n;
  -- Newest first in the document, so a message's position counts up from the oldest.
  insert into cumulus_rows.mail_messages (cid, id, ord, folder, thread_id, at, data)
    select b->>0, msg->>'id', jsonb_array_length(b->1->'messages') - k, msg->>'folder', msg->>'threadId', msg->>'at', msg
    from jsonb_array_elements(coalesce(m->'mailboxes'->'__map', '[]')) as t(b),
         jsonb_array_elements(coalesce(b->1->'messages', '[]')) with ordinality as x(msg, k);
  insert into cumulus_rows.mail_addresses (address, cid)
    select lower(e->>0), e->>1 from jsonb_array_elements(coalesce(m->'addresses'->'__map', '[]')) as t(e);
  insert into cumulus_rows.mail_outbound (id, status, data)
    select e->>0, e->1->>'status', e->1 from jsonb_array_elements(coalesce(m->'outbound'->'__map', '[]')) with ordinality as t(e, n) order by n;
  return jsonb_build_object(
    'mailboxes', (select count(*) from cumulus_rows.mail_mailboxes),
    'messages', (select count(*) from cumulus_rows.mail_messages),
    'addresses', (select count(*) from cumulus_rows.mail_addresses),
    'outbound', (select count(*) from cumulus_rows.mail_outbound));
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema cumulus_rows from anon, authenticated';
    execute 'revoke all on all sequences in schema cumulus_rows from anon, authenticated';
    execute 'revoke execute on function public.cid_read(jsonb) from anon, authenticated';
    execute 'revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) to service_role';
  end if;
end $$;
revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from public;
revoke execute on function cumulus_rows.read_one(jsonb) from public;
revoke execute on function cumulus_rows.apply(jsonb) from public;
revoke execute on function cumulus_rows.mail_read(jsonb) from public;
revoke execute on function cumulus_rows.mail_apply(jsonb) from public;
revoke execute on function cumulus_rows.refresh_mail_from_document() from public;
