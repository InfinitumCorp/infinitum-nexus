-- Rollback path for CUMULUS_STORE=gateway: rebuild the `cid` document from the cumulus_id rows.
--
--   select cumulus_id.document_from_rows();   the document as JSON (cid.json format), read-only
--   select cumulus_id.restore_document();     writes it into public.nexus_docs ('cid', version + 1, so
--                                              running servers reload it), then set
--                                              CUMULUS_STORE=document and deploy
--
-- Accounts created after the switch to rows come back with the rest. Single-use items (challenges,
-- MFA steps, OAuth state, handoffs) are not carried over; they expire within minutes.

create or replace function cumulus_id.document_from_rows() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'accounts', jsonb_build_object('__map', coalesce((select jsonb_agg(jsonb_build_array(cid, data) order by seq) from cumulus_id.cid_accounts), '[]')),
    'byUsername', jsonb_build_object('__map', coalesce((select jsonb_agg(jsonb_build_array(username, cid) order by seq) from cumulus_id.cid_accounts), '[]')),
    'byFederation', jsonb_build_object('__map', coalesce((select jsonb_agg(jsonb_build_array(key, cid) order by key) from cumulus_id.cid_federation), '[]')),
    'authenticators', jsonb_build_object('__map', coalesce((select jsonb_agg(jsonb_build_array(id, data) order by seq) from cumulus_id.cid_authenticators), '[]')),
    'byCredentialId', jsonb_build_object('__map', coalesce((select jsonb_agg(jsonb_build_array(credential_id, id) order by seq) from cumulus_id.cid_authenticators), '[]')),
    'sessions', jsonb_build_object('__map', coalesce((select jsonb_agg(jsonb_build_array(id, data) order by seq) from cumulus_id.cid_sessions), '[]')),
    'byTokenHash', jsonb_build_object('__map', coalesce((select jsonb_agg(jsonb_build_array(token_hash, id) order by seq) from cumulus_id.cid_sessions), '[]')),
    'grants', jsonb_build_object('__map', coalesce((select jsonb_agg(jsonb_build_array(cid || '|' || app, data) order by seq) from cumulus_id.cid_grants), '[]')),
    'orgs', jsonb_build_object('__map', coalesce((select jsonb_agg(jsonb_build_array(id, data) order by id) from cumulus_id.cid_orgs), '[]')),
    'challenges', jsonb_build_object('__map', '[]'::jsonb),
    'pendingMfa', jsonb_build_object('__map', '[]'::jsonb),
    'byIdentity', jsonb_build_object('__map', coalesce((select jsonb_agg(jsonb_build_array(key, cid) order by key) from cumulus_id.cid_identities), '[]')),
    'oauthPending', jsonb_build_object('__map', '[]'::jsonb),
    'deviceHandoffs', jsonb_build_object('__map', '[]'::jsonb)
  )
$$;

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
  return jsonb_build_object(
    'version', v,
    'accounts', jsonb_array_length(d->'accounts'->'__map'),
    'authenticators', jsonb_array_length(d->'authenticators'->'__map'),
    'sessions', jsonb_array_length(d->'sessions'->'__map'),
    'grants', jsonb_array_length(d->'grants'->'__map'));
end $$;

revoke execute on function cumulus_id.document_from_rows() from public;
revoke execute on function cumulus_id.restore_document() from public;

-- Before a switch (or any time after): how far the rows are from the `cid` document.
-- Returns {"same": true, ...counts} when every account, passkey, session and grant matches, else the
-- keys that differ (at most 20 per kind). Read-only.
create or replace function cumulus_id.compare_with_document() returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  d jsonb;
  diff jsonb := '{}'::jsonb;
  k text;
  docs jsonb;
  rows jsonb;
  missing jsonb;
  extra jsonb;
  changed jsonb;
begin
  select data into d from public.nexus_docs where id = 'cid';
  if d is null then raise exception 'nexus_docs has no cid row'; end if;
  for k in select unnest(array['accounts', 'authenticators', 'sessions', 'grants']) loop
    docs := coalesce((select jsonb_object_agg(e->>0, e->1) from jsonb_array_elements(coalesce(d->k->'__map', '[]')) e), '{}');
    rows := case k
      when 'accounts' then coalesce((select jsonb_object_agg(cid, data) from cumulus_id.cid_accounts), '{}')
      when 'authenticators' then coalesce((select jsonb_object_agg(id, data) from cumulus_id.cid_authenticators), '{}')
      when 'sessions' then coalesce((select jsonb_object_agg(id, data) from cumulus_id.cid_sessions), '{}')
      else coalesce((select jsonb_object_agg(cid || '|' || app, data) from cumulus_id.cid_grants), '{}')
    end;
    missing := coalesce((select jsonb_agg(key) from (select key from jsonb_object_keys(docs) key where not rows ? key limit 20) t), '[]');
    extra := coalesce((select jsonb_agg(key) from (select key from jsonb_object_keys(rows) key where not docs ? key limit 20) t), '[]');
    changed := coalesce((select jsonb_agg(key) from (select key from jsonb_object_keys(docs) key where rows ? key and rows->key <> docs->key limit 20) t), '[]');
    if jsonb_array_length(missing) + jsonb_array_length(extra) + jsonb_array_length(changed) > 0 then
      diff := diff || jsonb_build_object(k, jsonb_build_object('onlyInDocument', missing, 'onlyInRows', extra, 'changed', changed));
    end if;
  end loop;
  return jsonb_build_object(
    'same', diff = '{}'::jsonb,
    'document', jsonb_build_object('accounts', jsonb_array_length(coalesce(d->'accounts'->'__map', '[]')), 'sessions', jsonb_array_length(coalesce(d->'sessions'->'__map', '[]'))),
    'rows', jsonb_build_object('accounts', (select count(*) from cumulus_id.cid_accounts), 'sessions', (select count(*) from cumulus_id.cid_sessions))
  ) || case when diff = '{}'::jsonb then '{}'::jsonb else jsonb_build_object('differences', diff) end;
end $$;
revoke execute on function cumulus_id.compare_with_document() from public;
