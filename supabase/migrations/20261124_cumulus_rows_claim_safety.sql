-- The first-request claim (20261121, 20261122) never replaces rows that hold something else, and a
-- rollback hands the document back for good. Findings of an independent review:
--
-- - A claim copied the document over the rows whenever no claim was recorded, even if hosts had been
--   writing those rows already (the manual runbook before 20261121): accounts made since were lost.
--   Now, when the rows aren't empty, the claim compares them with the document first: the same, it is
--   recorded without copying; different, it is refused and the host doesn't serve (it says why). To go
--   ahead, either keep the rows (insert into cumulus_rows.claims (product, copied) values ('cid', '{}'))
--   or, if the document is right, release the product (below) and the next claim copies it.
-- - A rollback left the claim recorded, so a later switch back skipped the copy and the writes made on
--   the document in between were missing. cumulus_id.restore_document() and
--   cumulus_rows.restore_drive_document() now release their product, and
--   select cumulus_rows.release('mail');   -- (or 'wallet', 'quota') after removing it from CUMULUS_ROWS
--   does the same for the others: the next claim copies the document over the rows.
-- - A claim made while the document didn't exist yet was recorded, so the document, once written, was
--   never copied. Now nothing is recorded until there is a document.
-- - The version recorded with a claim could be older than what was copied: the document row is now
--   locked before its version is read.
-- - A claim and a commit of several documents could deadlock: the claim locks its documents in id
--   order (hosts send documents in id order too).
--
-- Release a product only when no host still serves it from rows: a host that already claimed keeps
-- writing rows, and the next claim would copy the document over them.

alter table cumulus_rows.claims add column if not exists released_at timestamptz;

create or replace function cumulus_rows.document_of(p_product text) returns text
language sql immutable set search_path = '' as $$
  select case p_product when 'cid' then 'cid' when 'mail' then 'cumulus-mail' when 'wallet' then 'firm-wallet'
    when 'quota' then 'cumulus-quota' when 'drive' then 'cumulus-workspace' end
$$;

-- Whether a product's rows hold anything.
create or replace function cumulus_rows.rows_present(p_product text) returns boolean
language plpgsql stable set search_path = '' as $$
begin
  return case p_product
    when 'cid' then exists (select 1 from cumulus_id.cid_accounts) or exists (select 1 from cumulus_id.cid_orgs)
    when 'mail' then exists (select 1 from cumulus_rows.mail_mailboxes) or exists (select 1 from cumulus_rows.mail_addresses) or exists (select 1 from cumulus_rows.mail_outbound)
    when 'wallet' then exists (select 1 from cumulus_rows.wallet_accounts) or exists (select 1 from cumulus_rows.wallet_transfers)
    when 'quota' then exists (select 1 from cumulus_rows.quota_usage)
    when 'drive' then exists (select 1 from cumulus_rows.drive_items) or exists (select 1 from cumulus_rows.drive_enabled)
  end;
end $$;

-- Whether a product's rows hold exactly what its document holds.
create or replace function cumulus_rows.rows_match_document(p_product text) returns boolean
language plpgsql stable set search_path = '' as $$
begin
  return coalesce((case p_product
    when 'cid' then cumulus_id.compare_with_document()
    when 'drive' then cumulus_rows.compare_drive_with_document()
    else cumulus_rows.compare_with_documents(array[p_product])
  end)->>'same', 'false')::boolean;
end $$;

-- Hand one document over to its rows, once. Returns what was done:
--   {"already": true}                      claimed before
--   {"claimed": true, "copied": {...}}     the document was copied over the rows
--   {"claimed": true, "matched": true}     the rows already held the document's contents
--   {"noDocument": true}                   nothing to hand over yet; nothing recorded
--   {"refused": "rows_differ"}             the rows hold something else; nothing changed (see above)
create or replace function cumulus_rows.claim(p_product text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  doc_id text := cumulus_rows.document_of(p_product);
  c record;
  claimed_before boolean;
  v bigint;
  copied jsonb;
begin
  if doc_id is null then raise exception 'claim: unknown product %', p_product; end if;
  perform pg_advisory_xact_lock(hashtext('cumulus_rows.claim|' || p_product));
  select * into c from cumulus_rows.claims where product = p_product;
  claimed_before := found; -- before the next SELECT INTO resets FOUND
  if claimed_before and c.released_at is null then return jsonb_build_object('already', true); end if;
  -- Locked before its version is read: a commit of the document in progress finishes first.
  select version into v from public.nexus_docs where id = doc_id for share;
  if v is null then return jsonb_build_object('noDocument', true); end if;
  if not claimed_before and cumulus_rows.rows_present(p_product) then
    if not cumulus_rows.rows_match_document(p_product) then
      return jsonb_build_object('refused', 'rows_differ');
    end if;
    insert into cumulus_rows.claims (product, document_version, copied) values (p_product, v, jsonb_build_object('matched', true));
    return jsonb_build_object('claimed', true, 'documentVersion', v, 'matched', true);
  end if;
  copied := case p_product
    when 'cid' then cumulus_id.refresh_from_document()
    when 'mail' then cumulus_rows.refresh_mail_from_document()
    when 'wallet' then cumulus_rows.refresh_wallet_from_document()
    when 'drive' then cumulus_rows.refresh_drive_from_document()
    else cumulus_rows.refresh_quota_from_document()
  end;
  insert into cumulus_rows.claims (product, document_version, copied) values (p_product, v, copied)
    on conflict (product) do update set claimed_at = now(), document_version = excluded.document_version, copied = excluded.copied, released_at = null;
  return jsonb_build_object('claimed', true, 'documentVersion', v, 'copied', copied);
end $$;

-- The document is the truth again (after a rollback): the next claim copies it over the rows.
create or replace function cumulus_rows.release(p_product text) returns jsonb
language plpgsql set search_path = '' as $$
begin
  if cumulus_rows.document_of(p_product) is null then raise exception 'release: unknown product %', p_product; end if;
  perform pg_advisory_xact_lock(hashtext('cumulus_rows.claim|' || p_product));
  update cumulus_rows.claims set released_at = now() where product = p_product;
  return jsonb_build_object('released', found);
end $$;

-- 20261114's rollback, now also releasing the cid claim.
create or replace function cumulus_id.restore_document() returns jsonb
language plpgsql set search_path = '' as $$
declare
  d jsonb := cumulus_id.document_from_rows();
  v bigint;
begin
  update public.nexus_docs set data = d, version = version + 1, updated_at = now() where id = 'cid' returning version into v;
  if v is null then
    insert into public.nexus_docs (id, version, data) values ('cid', 1, d);
    v := 1;
  end if;
  perform cumulus_rows.release('cid');
  return jsonb_build_object(
    'version', v,
    'accounts', jsonb_array_length(d->'accounts'->'__map'),
    'authenticators', jsonb_array_length(d->'authenticators'->'__map'),
    'sessions', jsonb_array_length(d->'sessions'->'__map'),
    'grants', jsonb_array_length(d->'grants'->'__map'));
end $$;

-- 20261122's Drive rollback, releasing the claim instead of deleting it.
create or replace function cumulus_rows.restore_drive_document() returns jsonb
language plpgsql set search_path = '' as $$
declare
  d jsonb;
  v bigint;
begin
  perform pg_advisory_xact_lock(hashtext('cumulus_rows.claim|drive'));
  lock table cumulus_rows.drive_items, cumulus_rows.drive_enabled in share mode;
  d := cumulus_rows.drive_document_from_rows();
  update public.nexus_docs set data = d, version = version + 1, updated_at = now() where id = 'cumulus-workspace' returning version into v;
  if v is null then
    insert into public.nexus_docs (id, version, data) values ('cumulus-workspace', 1, d);
    v := 1;
  end if;
  update cumulus_rows.claims set released_at = now() where product = 'drive';
  return jsonb_build_object('version', v, 'items', jsonb_array_length(d->'items'->'__map'), 'enabled', jsonb_array_length(d->'enabled'->'__map'));
end $$;

-- 20261123's commit; claims take their document locks first, in id order.
create or replace function public.nexus_commit_cid(p_entries jsonb, p_docs jsonb, p_cid jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  result jsonb;
  o jsonb;
begin
  result := public.nexus_commit(p_entries, p_docs);
  perform 1 from public.nexus_docs
    where id in (select cumulus_rows.document_of(value->>'id') from jsonb_array_elements(coalesce(p_cid, '[]'::jsonb)) where value->>'kind' = 'claim')
    order by id for share;
  for o in select value from jsonb_array_elements(coalesce(p_cid, '[]'::jsonb)) where value->>'kind' = 'claim' order by value->>'id' loop
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
  if exists (
    select 1 from cumulus_rows.drive_items c
    where c.parent in (select value->>'id' from jsonb_array_elements(coalesce(p_cid, '[]'::jsonb))
                       where value->>'kind' = 'driveItem' and value ? 'data' and value->'data' = 'null'::jsonb)
  ) then
    raise exception 'nexus_conflict' using errcode = 'P0001';
  end if;
  return result;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) to service_role';
  end if;
end $$;
revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from public;
revoke execute on function cumulus_rows.claim(text) from public;
revoke execute on function cumulus_rows.release(text) from public;
revoke execute on function cumulus_rows.document_of(text) from public;
revoke execute on function cumulus_rows.rows_present(text) from public;
revoke execute on function cumulus_rows.rows_match_document(text) from public;
revoke execute on function cumulus_id.restore_document() from public;
revoke execute on function cumulus_rows.restore_drive_document() from public;
