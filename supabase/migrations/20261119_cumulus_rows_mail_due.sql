-- Scheduled send runs at the start of every request; through the gateway it read every mailbox to find
-- drafts that are due. The "mailboxCids" lookup now takes `dueBy` and answers from the message rows.
-- Replaces mail_read from 20261117_cumulus_rows_mail_counts.sql; nothing else changes.

create or replace function cumulus_rows.mail_read(o jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
begin
  case o->>'op'
    -- { op: "mailbox", cid, only: "exists" | "unread" }: answered without returning the mailbox.
    when 'mailbox' then
      if o->>'only' = 'exists' then return to_jsonb(exists (select 1 from cumulus_rows.mail_mailboxes where cid = o->>'cid')); end if;
      if o->>'only' = 'unread' then return to_jsonb((select count(distinct thread_id) from cumulus_rows.mail_messages
        where cid = o->>'cid' and folder = 'inbox' and (data->>'unread')::boolean)); end if;
      return (select jsonb_build_object('version', b.version, 'data', b.data, 'messages',
        coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'ord', m.ord, 'data', m.data) order by m.ord desc) from cumulus_rows.mail_messages m where m.cid = b.cid), '[]'))
      from cumulus_rows.mail_mailboxes b where b.cid = o->>'cid');
    -- { op: "mailboxCids", dueBy }: only accounts with a scheduled draft due by then.
    when 'mailboxCids' then
      if o ? 'dueBy' then return coalesce((select jsonb_agg(distinct cid) from cumulus_rows.mail_messages
        where folder = 'drafts' and data->>'sendAt' is not null and (data->>'sendAt')::timestamptz <= (o->>'dueBy')::timestamptz), '[]'); end if;
      return coalesce((select jsonb_agg(cid order by seq) from cumulus_rows.mail_mailboxes), '[]');
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

revoke execute on function cumulus_rows.mail_read(jsonb) from public;
