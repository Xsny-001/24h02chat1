-- ============================================================
-- 行级安全策略 (RLS Policies)
-- 原则：用户可读 users/rooms/messages/dms；写操作（消息/私聊）受可见性约束；
--       管理类变更（审批/角色/禁言/撤回/房间管理/审计）一律走 rpc.sql 的
--       security definer 函数，绝不直接开放表写权限。
-- 在 Supabase SQL Editor 执行（紧随 schema.sql / triggers.sql 之后）
-- ============================================================

-- ---------- users：登录用户可读；写入由 trigger，变更由 RPC ----------
drop policy if exists users_select on public.users;
create policy users_select on public.users
  for select to authenticated using (true);

-- ---------- rooms：公开房间所有人可读，私有房间仅成员 ----------
drop policy if exists rooms_public_select on public.rooms;
create policy rooms_public_select on public.rooms
  for select to authenticated using (type = 'public');
drop policy if exists rooms_private_select on public.rooms;
create policy rooms_private_select on public.rooms
  for select to authenticated using (auth.uid() = any(members));

-- ---------- messages：可进入房间者可读，可插入到自己可进入的房间 ----------
drop policy if exists messages_select on public.messages;
create policy messages_select on public.messages
  for select to authenticated using (
    exists (select 1 from public.rooms r
            where r.id = room_id and (r.type = 'public' or auth.uid() = any(r.members)))
  );
drop policy if exists messages_insert on public.messages;
create policy messages_insert on public.messages
  for insert to authenticated with check (
    auth.uid() = user_id
    and exists (select 1 from public.rooms r
                where r.id = room_id and (r.type = 'public' or auth.uid() = any(r.members)))
  );

-- ---------- dms：仅双方可读可插 ----------
drop policy if exists dms_select on public.dms;
create policy dms_select on public.dms
  for select to authenticated using (auth.uid() = from_id or auth.uid() = to_id);
drop policy if exists dms_insert on public.dms;
create policy dms_insert on public.dms
  for insert to authenticated with check (auth.uid() = from_id);

-- ---------- blocks：仅本人 ----------
drop policy if exists blocks_all on public.blocks;
create policy blocks_all on public.blocks
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- reports / audit / mutes：不开放直连，全部经 RPC ----------
-- （不创建 select/insert policy → 默认拒绝，安全由 security definer 函数保证）
