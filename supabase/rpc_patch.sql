-- ============================================================
-- rpc.sql 补丁（在 schema/triggers/policies/rpc 之后执行）
-- 1) 本人可撤回自己的房间消息  2) 新增私聊举报 RPC
-- ============================================================

-- 覆盖 recall_message：mod+ 或消息作者本人可撤回
create or replace function public.recall_message(rid uuid, mid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_mod_plus() or exists(
      select 1 from public.messages m where m.id = mid and m.room_id = rid and m.user_id = auth.uid()))
  then
    raise exception 'no_permission';
  end if;
  update public.messages set recalled = true,
    recalled_by = (select username from public.users where id = auth.uid()), text = ''
    where id = mid and room_id = rid;
  perform public.log_audit('message.recall', (select name from public.rooms where id = rid), mid::text);
end;
$$;

-- 私聊举报（kind='dm'）
create or replace function public.add_dm_report(conv text, message_id uuid, reason text)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if exists(select 1 from public.reports where message_id = message_id and reporter_id = me and status = 'open') then
    return;
  end if;
  insert into public.reports(kind, message_id, conv_key, reporter_id, reason, status, created_at)
    values ('dm', message_id, conv, me, reason, 'open', extract(epoch from now())::bigint * 1000);
  perform public.log_audit('report.create', '', reason);
end;
$$;
