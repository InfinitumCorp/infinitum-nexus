-- Least-privilege grants for the Labyrinth host's own login role.
-- The role itself is created by an operator with a SCRAM verifier generated outside the
-- repository (see docs/LBRNTH-HOSTED.md); no password or verifier is ever committed.
--   create role lbrnth_host login noinherit password '<SCRAM-SHA-256 verifier>';
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'lbrnth_host') then
    raise notice 'lbrnth_host does not exist yet; create it, then re-run this migration';
    return;
  end if;
  execute 'alter role lbrnth_host set search_path = lbrnth';
  execute 'alter role lbrnth_host connection limit 20';
  execute 'grant usage on schema lbrnth to lbrnth_host';
  execute 'grant select, insert, update on lbrnth.org_snapshots to lbrnth_host';
  execute 'grant select, insert, delete on lbrnth.delegations to lbrnth_host';
  execute 'grant select on lbrnth.entitlements to lbrnth_host';
  execute 'alter table lbrnth.org_snapshots force row level security';
  if not exists (select 1 from pg_policies where schemaname = 'lbrnth' and tablename = 'org_snapshots' and policyname = 'lbrnth_host_all') then
    execute 'create policy lbrnth_host_all on lbrnth.org_snapshots for all to lbrnth_host using (true) with check (true)';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'lbrnth' and tablename = 'delegations' and policyname = 'lbrnth_host_all') then
    execute 'create policy lbrnth_host_all on lbrnth.delegations for all to lbrnth_host using (true) with check (true)';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'lbrnth' and tablename = 'entitlements' and policyname = 'lbrnth_host_read') then
    execute 'create policy lbrnth_host_read on lbrnth.entitlements for select to lbrnth_host using (true)';
  end if;
end $$;
