-- Cumulus://Drive through nexus-store: a request's decisions hold when it is saved. Builds on
-- 20261122_cumulus_rows_drive.sql (the edge function doesn't change).
--
-- - A request also sends the items it only read one at a time as checks ({"kind": "driveItem",
--   "check": true, "expect": <as read>}): a folder something was moved into, the folders above an item
--   it was allowed to change. If one changed meanwhile, the commit raises nexus_conflict and the request
--   re-runs. Without this, two moves at once (A into B, B into A) could both be saved, leaving both
--   folders inside each other and gone from view.
-- - A commit that deletes a folder is refused if an item still sits in it afterwards (one added by a
--   request that committed first): the deletion re-runs and takes it too, instead of leaving it in a
--   folder that no longer exists.

create or replace function cumulus_rows.drive_apply(o jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  cur jsonb;
  checked boolean := o ? 'expect';
  want jsonb := nullif(o->'expect', 'null'::jsonb);
  d jsonb := nullif(o->'data', 'null'::jsonb);
begin
  if o->>'kind' = 'driveItem' and coalesce((o->>'check')::boolean, false) then
    -- A share lock: a write to this item in another request waits for this one, and this one for it.
    select data into cur from cumulus_rows.drive_items where id = o->>'id' for share;
    if cur is distinct from want then raise exception 'nexus_conflict' using errcode = 'P0001'; end if;
    return;
  end if;
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

-- 20261122's commit, then: nothing may be left inside a Drive item this commit deleted.
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
revoke execute on function cumulus_rows.drive_apply(jsonb) from public;
