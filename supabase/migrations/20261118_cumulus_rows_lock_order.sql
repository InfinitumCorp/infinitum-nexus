-- Row writes in a fixed order. nexus_commit_cid applied a request's writes in the order the request
-- made them, and each takes a lock on its key: A mailing B charged and wrote A's quota and mailbox
-- before B's, while B mailing A did the reverse, so two such requests at once could deadlock, and the
-- deadlock came back as a store error instead of a re-run. Sorting the writes gives every request the
-- same lock order. Replaces nexus_commit_cid from 20261116_cumulus_rows_mail.sql; nothing else changes.

create or replace function public.nexus_commit_cid(p_entries jsonb, p_docs jsonb, p_cid jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  result jsonb;
  o jsonb;
begin
  result := public.nexus_commit(p_entries, p_docs);
  -- One order for every request (by kind, then key; a key's own writes keep their order), so two
  -- requests writing the same rows take their locks in the same order and can't deadlock.
  for o in select value from jsonb_array_elements(coalesce(p_cid, '[]'::jsonb)) with ordinality as t(value, n)
           order by value->>'kind', value->>'id', n loop
    if o->>'kind' in ('wallet', 'transfer', 'quota', 'mailbox', 'message', 'messageDelete', 'mailAddress', 'outbound') then perform cumulus_rows.apply(o);
    else perform cumulus_id.apply(o); end if;
  end loop;
  return result;
end $$;

revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.nexus_commit_cid(jsonb, jsonb, jsonb) to service_role';
  end if;
end $$;
