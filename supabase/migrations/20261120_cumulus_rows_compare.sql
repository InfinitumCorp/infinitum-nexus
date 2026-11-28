-- Before a switch to CUMULUS_ROWS (or any time after, while the documents are kept): how far the
-- cumulus_rows tables are from the firm-wallet, cumulus-quota and cumulus-mail documents.
--
--   select cumulus_rows.compare_with_documents();                          -- mail, wallet and quota
--   select cumulus_rows.compare_with_documents(array['wallet', 'quota']);  -- only what CUMULUS_ROWS lists
--
-- Returns {"same": true, ...counts} when every wallet, transfer, storage meter, mailbox (with its
-- messages, in order), address and outbound job matches, else the keys that differ (at most 20 per
-- kind). Read-only. A product not asked for, or whose document doesn't exist, is skipped.

create or replace function cumulus_rows.compare_with_documents(p_products text[] default array['mail', 'wallet', 'quota']) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  w jsonb;
  q jsonb;
  m jsonb;
  diff jsonb := '{}'::jsonb;
  counts jsonb := '{}'::jsonb;
  docs jsonb;
  rows jsonb;
  k text;
begin
  if 'wallet' = any(p_products) then select data into w from public.nexus_docs where id = 'firm-wallet'; end if;
  if 'quota' = any(p_products) then select data into q from public.nexus_docs where id = 'cumulus-quota'; end if;
  if 'mail' = any(p_products) then select data into m from public.nexus_docs where id = 'cumulus-mail'; end if;

  for k in select unnest(array['wallets', 'transfers', 'quotas', 'mailboxes', 'addresses', 'outbound']) loop
    docs := null;
    rows := null;
    case k
      when 'wallets' then
        if w is null then continue; end if;
        docs := coalesce((select jsonb_object_agg(e->>0, e->1) from jsonb_array_elements(coalesce(w->'accounts'->'__map', '[]')) e), '{}');
        rows := coalesce((select jsonb_object_agg(cid, data) from cumulus_rows.wallet_accounts), '{}');
      when 'transfers' then
        if w is null then continue; end if;
        docs := coalesce((select jsonb_object_agg(e->>0, e->1) from jsonb_array_elements(coalesce(w->'transfers'->'__map', '[]')) e), '{}');
        rows := coalesce((select jsonb_object_agg(id, data) from cumulus_rows.wallet_transfers), '{}');
      when 'quotas' then
        if q is null then continue; end if;
        -- Usage and extra storage, as numbers; a person with neither in the document matches no row or a zero row.
        docs := coalesce((select jsonb_object_agg(c, jsonb_build_object(
                    'mail', coalesce((u->>'mail')::numeric, 0), 'cloud', coalesce((u->>'cloud')::numeric, 0),
                    'extraGb', coalesce((select (x->>1)::numeric from jsonb_array_elements(coalesce(q->'extraGb'->'__map', '[]')) x where x->>0 = c), 0)))
                  from (select e->>0 as c, e->1 as u from jsonb_array_elements(coalesce(q->'usage'->'__map', '[]')) e
                        union select x->>0, null from jsonb_array_elements(coalesce(q->'extraGb'->'__map', '[]')) x
                          where not exists (select 1 from jsonb_array_elements(coalesce(q->'usage'->'__map', '[]')) e where e->>0 = x->>0)) t), '{}');
        rows := coalesce((select jsonb_object_agg(cid, jsonb_build_object('mail', mail_bytes::numeric, 'cloud', cloud_bytes::numeric, 'extraGb', extra_gb))
                  from cumulus_rows.quota_usage), '{}');
      when 'mailboxes' then
        if m is null then continue; end if;
        -- A mailbox: its fields other than messages, plus its message ids newest first and each message.
        docs := coalesce((select jsonb_object_agg(e->>0, jsonb_build_object(
                    'box', ((e->1) - 'messages') || jsonb_build_object('cid', e->>0),
                    'messages', coalesce(e->1->'messages', '[]')))
                  from jsonb_array_elements(coalesce(m->'mailboxes'->'__map', '[]')) e), '{}');
        rows := coalesce((select jsonb_object_agg(b.cid, jsonb_build_object(
                    'box', b.data,
                    'messages', coalesce((select jsonb_agg(x.data order by x.ord desc) from cumulus_rows.mail_messages x where x.cid = b.cid), '[]')))
                  from cumulus_rows.mail_mailboxes b), '{}');
      when 'addresses' then
        if m is null then continue; end if;
        docs := coalesce((select jsonb_object_agg(lower(e->>0), e->1) from jsonb_array_elements(coalesce(m->'addresses'->'__map', '[]')) e), '{}');
        rows := coalesce((select jsonb_object_agg(address, to_jsonb(cid)) from cumulus_rows.mail_addresses), '{}');
      when 'outbound' then
        if m is null then continue; end if;
        docs := coalesce((select jsonb_object_agg(e->>0, e->1) from jsonb_array_elements(coalesce(m->'outbound'->'__map', '[]')) e), '{}');
        rows := coalesce((select jsonb_object_agg(id, data) from cumulus_rows.mail_outbound), '{}');
    end case;
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
revoke execute on function cumulus_rows.compare_with_documents(text[]) from public;
