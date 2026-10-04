-- ============================================================
-- 迁移补全：房间消息支持图片/附件 + 撤回保留原文
-- 在已执行过 schema/triggers/policies/rpc/rpc_patch 之后追加执行一次即可
-- 本文件幂等（if not exists），可重复执行
-- ============================================================

-- 1) messages 表增加附件字段（原来只有私聊 dms 有，房间消息发不了图）
alter table public.messages add column if not exists file_stored text;
alter table public.messages add column if not exists file_name   text;
alter table public.messages add column if not exists file_size   int;
alter table public.messages add column if not exists file_mime   text;

-- 2) 撤回不再清空 text（recall_message / recall_dm 已在 rpc_patch.sql 中改为只置 recalled 标记）
--    这样普通用户看到“已撤回”，管理员在后台仍可看到原文用于审核。
--    下面两段 CREATE OR REPLACE 与 rpc_patch.sql 内容一致，重复执行无害。
create or replace function public.recall_message(rid uuid, mid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_mod_plus() or exists(
      select 1 from public.messages m where m.id = mid and m.room_id = rid and m.user_id = auth.uid()))
  then
    raise exception 'no_permission';
  end if;
  update public.messages set recalled = true,
    recalled_by = (select username from public.users where id = auth.uid())
    where id = mid and room_id = rid;
  perform public.log_audit('message.recall', (select name from public.rooms where id = rid), mid::text);
end;
$$;

create or replace function public.recall_dm(conv text, mid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_mod_plus() or exists(select 1 from public.dms d where d.id=mid and d.conv_key=conv and d.from_id=auth.uid())) then
    raise exception 'no_permission';
  end if;
  update public.dms set recalled=true, recalled_by=(select username from public.users where id=auth.uid()) where id=mid and conv_key=conv;
  perform public.log_audit('message.recall', '私聊', mid::text);
end;
$$;
