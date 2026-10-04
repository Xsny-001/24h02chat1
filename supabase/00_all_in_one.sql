-- 24h02chat · Supabase 全量迁移（按顺序一次执行即可）
-- ============================================================
-- schema.sql
-- ============================================================
-- ============================================================
-- chat-app → Supabase 方案 B：数据库 Schema
-- 在 Supabase SQL Editor 中一次性执行本文件
-- ============================================================

-- ---------- users（身份与角色）----------
create table if not exists public.users (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text unique not null,
  role         text not null default 'user' check (role in ('user','mod','admin')),
  status       text not null default 'pending' check (status in ('pending','active','banned')),
  muted_until  bigint default 0,            -- 全站禁言截止时间(ms)
  created_at   bigint,
  approved_at  bigint,
  approved_by  uuid
);
create index if not exists users_username_idx on public.users (username);

-- ---------- rooms（房间）----------
create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  type        text not null default 'public' check (type in ('public','private')),
  owner_id    uuid references public.users(id) on delete set null,
  members     uuid[] not null default '{}',  -- 私有房间成员
  announce    text default '',
  created_at  bigint
);
create index if not exists rooms_name_idx on public.rooms (name);

-- ---------- messages（房间消息）----------
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.rooms(id) on delete cascade,
  user_id     uuid references public.users(id) on delete set null,
  nick        text not null,
  text        text not null default '',
  ts          bigint not null,
  recalled    boolean not null default false,
  recalled_by text
);
create index if not exists messages_room_ts_idx on public.messages (room_id, ts);

-- ---------- dms（私聊消息）----------
create table if not exists public.dms (
  id          uuid primary key default gen_random_uuid(),
  conv_key    text not null,             -- 双方 id 排序拼接
  from_id     uuid references public.users(id) on delete set null,
  to_id       uuid references public.users(id) on delete set null,
  nick        text not null,
  text        text not null default '',
  file_id     text,
  file_stored text,
  file_name   text,
  file_size   int,
  file_mime   text,
  ts          bigint not null,
  recalled    boolean not null default false,
  recalled_by text,
  read_at     bigint
);
create index if not exists dms_conv_ts_idx on public.dms (conv_key, ts);

-- ---------- blocks（拉黑）----------
create table if not exists public.blocks (
  user_id     uuid not null references public.users(id) on delete cascade,
  blocked_id  uuid not null references public.users(id) on delete cascade,
  ts          bigint,
  primary key (user_id, blocked_id)
);

-- ---------- reports（举报）----------
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'room' check (kind in ('room','dm')),
  message_id  uuid,
  room_id     uuid,
  conv_key    text,
  reporter_id uuid references public.users(id) on delete set null,
  reason      text default '',
  status      text not null default 'open' check (status in ('open','resolved','dismissed')),
  handled_by  text,
  handled_at  bigint,
  created_at  bigint
);

-- ---------- audit（审计日志）----------
create table if not exists public.audit (
  id          uuid primary key default gen_random_uuid(),
  ts          bigint not null,
  actor_id    uuid,
  actor_name  text,
  action      text,
  target      text,
  detail      text
);

-- ---------- mutes（禁言记录）----------
create table if not exists public.mutes (
  user_id     uuid not null references public.users(id) on delete cascade,
  room_id     uuid,                       -- null 表示全站禁言
  until       bigint not null,
  by          uuid,
  by_name     text,
  reason      text default '',
  ts          bigint
);

-- ---------- 开启 RLS（策略在 policies.sql）----------
alter table public.users   enable row level security;
alter table public.rooms   enable row level security;
alter table public.messages enable row level security;
alter table public.dms     enable row level security;
alter table public.blocks  enable row level security;
alter table public.reports enable row level security;
alter table public.audit   enable row level security;
alter table public.mutes   enable row level security;

-- ---------- Storage：私聊附件 bucket ----------
-- 附件桶设为 public：文件名含 uuid 不可枚举，前端用 getPublicUrl 直接访问，免去 storage RLS 复杂度
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', true)
on conflict (id) do nothing;

-- 将消息/私聊表加入 Realtime 发布，使前端能订阅 INSERT 推送（房间消息实时刷新）
alter publication supabase_realtime add table public.messages, public.dms;

-- ---------- Storage 访问策略 ----------
-- 桶设为 public 仅决定「读」公开；「上传(insert)」仍需策略，否则 anon key 会被 RLS 拒绝。
-- 文件名含 uuid 不可枚举，故仅限制 bucket_id，不限制具体路径。
drop policy if exists attachments_insert on storage.objects;
create policy attachments_insert on storage.objects
  for insert to authenticated with check ( bucket_id = 'attachments' );
drop policy if exists attachments_update on storage.objects;
create policy attachments_update on storage.objects
  for update to authenticated using ( bucket_id = 'attachments' );
drop policy if exists attachments_select on storage.objects;
create policy attachments_select on storage.objects
  for select to authenticated, anon using ( bucket_id = 'attachments' );

-- ============================================================
-- triggers.sql
-- ============================================================
-- ============================================================
-- 新用户自动建档触发器
-- 规则：首个注册用户 → 自动管理员 + 激活；其余 → 待审批(pending)
-- 在 Supabase SQL Editor 执行
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_first boolean;
  uname    text;
begin
  -- 用注册时传入的 username；缺失则取 email 前缀兜底
  uname := coalesce(nullif(trim(new.raw_user_meta_data->>'username'), ''),
                    split_part(new.email, '@', 1));

  select (count(*) = 0) into is_first from public.users;

  insert into public.users (id, username, role, status, created_at, approved_at, approved_by)
  values (
    new.id,
    uname,
    case when is_first then 'admin'  else 'user'  end,
    case when is_first then 'active' else 'pending' end,
    extract(epoch from now())::bigint * 1000,
    case when is_first then extract(epoch from now())::bigint * 1000 else null end,
    case when is_first then new.id else null end
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- policies.sql
-- ============================================================
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

-- ============================================================
-- rpc.sql
-- ============================================================
-- ============================================================
-- 管理动作与数据查询 RPC（全部 security definer，函数内校验角色）
-- RLS 之外的安全闸门：前端只调这些函数，绝不直接写表
-- 在 Supabase SQL Editor 执行（在 schema.sql / triggers.sql / policies.sql 之后）
-- ============================================================

-- 会话 key 生成（与前端 [a,b].sort().join(':') 一致）
create or replace function public.conv_key(a uuid, b uuid) returns text
language sql immutable as $$ select least(a::text,b::text)||':'||greatest(a::text,b::text); $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_mod_plus() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = auth.uid() and role in ('mod','admin'));
$$;

create or replace function public.log_audit(action text, target text default '', detail text default '')
returns void language sql security definer set search_path = public as $$
  insert into public.audit(ts, actor_id, actor_name, action, target, detail)
  values (extract(epoch from now())::bigint * 1000, auth.uid(),
    coalesce((select username from public.users where id = auth.uid()),'system'),
    action, target, detail);
$$;

-- ================= 用户管理 =================
create or replace function public.approve_user(target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'no_permission'; end if;
  update public.users set status='active', approved_at=extract(epoch from now())::bigint*1000, approved_by=auth.uid()
    where id=target and status='pending';
  perform public.log_audit('user.approve', (select username from public.users where id=target));
end;
$$;

create or replace function public.reject_user(target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'no_permission'; end if;
  delete from auth.users where id=target;  -- 级联删除 users 行
end;
$$;

create or replace function public.set_user_role(target uuid, role text)
returns void language plpgsql security definer set search_path = public as $$
declare old text;
begin
  if not public.is_admin() then raise exception 'no_permission'; end if;
  if role not in ('user','mod','admin') then raise exception 'bad_role'; end if;
  select u.role into old from public.users u where u.id=target;
  if old='admin' and role<>'admin' and
     (select count(*) from public.users where role='admin' and status='active') <= 1
  then raise exception 'last_admin'; end if;
  if target = auth.uid() then raise exception 'self_role'; end if;
  update public.users set role=role where id=target;
  perform public.log_audit('user.role', (select username from public.users where id=target), old||' -> '||role);
end;
$$;

create or replace function public.set_user_status(target uuid, status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'no_permission'; end if;
  if status not in ('active','banned') then raise exception 'bad_status'; end if;
  if target = auth.uid() then raise exception 'self_ban'; end if;
  if status='banned' and (select role from public.users where id=target)='admin' and
     (select count(*) from public.users where role='admin' and status='active') <= 1
  then raise exception 'last_admin'; end if;
  update public.users set status=status where id=target;
  perform public.log_audit('user.status', (select username from public.users where id=target), status);
end;
$$;

create or replace function public.mute_user(target uuid, minutes int, room_id uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare until bigint := extract(epoch from now())::bigint*1000 + coalesce(minutes,10)*60000;
begin
  if not public.is_mod_plus() then raise exception 'no_permission'; end if;
  insert into public.mutes(user_id, room_id, until, by, by_name, reason, ts)
    values(target, room_id, until, auth.uid(), (select username from public.users where id=auth.uid()), '', extract(epoch from now())::bigint*1000);
  if room_id is null then
    update public.users set muted_until=until where id=target;
  end if;
  perform public.log_audit('user.mute', (select username from public.users where id=target), coalesce(minutes,10)::text||' 分钟');
end;
$$;

create or replace function public.unmute_user(target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod_plus() then raise exception 'no_permission'; end if;
  delete from public.mutes where user_id=target and until > extract(epoch from now())::bigint*1000;
  update public.users set muted_until=0 where id=target;
  perform public.log_audit('user.unmute', (select username from public.users where id=target));
end;
$$;

-- ================= 房间管理 =================
create or replace function public.add_room(name text, type text)
returns uuid language plpgsql security definer set search_path = public as $$
declare rid uuid;
begin
  if not public.is_mod_plus() then raise exception 'no_permission'; end if;
  insert into public.rooms(name, type, owner_id, created_at)
    values (name, coalesce(nullif(type,''),'public'), auth.uid(), extract(epoch from now())::bigint*1000)
    returning id into rid;
  perform public.log_audit('room.create', name);
  return rid;
end;
$$;

create or replace function public.delete_room(rid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'no_permission'; end if;
  delete from public.messages where room_id=rid;
  delete from public.rooms where id=rid;
  perform public.log_audit('room.delete', (select name from public.rooms where id=rid));
end;
$$;

create or replace function public.set_announce(rid uuid, text text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod_plus() then raise exception 'no_permission'; end if;
  update public.rooms set announce=text where id=rid;
  perform public.log_audit('room.announce', (select name from public.rooms where id=rid));
end;
$$;

create or replace function public.set_member(rid uuid, uid uuid, is_member boolean)
returns void language plpgsql security definer set search_path = public as $$
declare room_type text;
begin
  if not public.is_admin() then raise exception 'no_permission'; end if;
  select type into room_type from public.rooms where id=rid;
  if room_type<>'private' then raise exception 'not_private'; end if;
  if is_member then
    update public.rooms set members = array_append(members, uid) where id=rid and not (members @> array[uid]);
  else
    update public.rooms set members = array_remove(members, uid) where id=rid;
  end if;
  perform public.log_audit('room.member.'||(case when is_member then 'add' else 'remove' end), (select username from public.users where id=uid));
end;
$$;

-- ================= 消息管理 =================
create or replace function public.recall_message(rid uuid, mid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod_plus() then raise exception 'no_permission'; end if;
  update public.messages set recalled=true, recalled_by=(select username from public.users where id=auth.uid()), text='' where id=mid and room_id=rid;
  perform public.log_audit('message.recall', (select name from public.rooms where id=rid), mid::text);
end;
$$;

create or replace function public.delete_message(rid uuid, mid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod_plus() then raise exception 'no_permission'; end if;
  delete from public.messages where id=mid and room_id=rid;
end;
$$;

create or replace function public.recall_dm(conv text, mid uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_mod_plus() or exists(select 1 from public.dms d where d.id=mid and d.conv_key=conv and d.from_id=auth.uid())) then
    raise exception 'no_permission';
  end if;
  update public.dms set recalled=true, recalled_by=(select username from public.users where id=auth.uid()), text='' where id=mid and conv_key=conv;
  perform public.log_audit('message.recall', '私聊', mid::text);
end;
$$;

create or replace function public.resolve_report(rid uuid, status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_mod_plus() then raise exception 'no_permission'; end if;
  if status not in ('resolved','dismissed') then raise exception 'bad_status'; end if;
  update public.reports set status=status, handled_by=(select username from public.users where id=auth.uid()), handled_at=extract(epoch from now())::bigint*1000
    where id=rid;
end;
$$;

-- ================= 用户侧操作 =================
create or replace function public.add_report(room_id uuid, message_id uuid, reason text)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if exists(select 1 from public.reports where message_id=message_id and reporter_id=me and status='open') then
    return; -- 去重
  end if;
  insert into public.reports(kind, message_id, room_id, reporter_id, reason, status, created_at)
    values('room', message_id, room_id, me, reason, 'open', extract(epoch from now())::bigint*1000);
  perform public.log_audit('report.create', '', reason);
end;
$$;

create or replace function public.toggle_block(target uuid, blocked boolean)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if blocked then
    insert into public.blocks(user_id, blocked_id, ts)
      values(me, target, extract(epoch from now())::bigint*1000)
      on conflict do nothing;
  else
    delete from public.blocks where user_id=me and blocked_id=target;
  end if;
end;
$$;

-- ================= 私聊会话 / 未读 =================
create or replace function public.mark_read(conv text)
returns int language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); n int;
begin
  update public.dms set read_at = extract(epoch from now())::bigint*1000
    where conv_key=conv and to_id=me and read_at is null and not recalled;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.get_conversations()
returns table (
  conv_key text, peer_id uuid, peer_name text, last_text text, last_ts bigint,
  unread int, blocked bool, blocked_me bool
)
language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  return query
  with mine as (select * from public.dms d where me in (d.from_id, d.to_id)),
       convs as (select conv_key from mine group by conv_key),
       lastmsg as (select distinct on (conv_key) * from mine order by conv_key, ts desc),
       peer_map as (
         select c.conv_key,
           case when split_part(c.conv_key,':',1)::uuid = me
                then split_part(c.conv_key,':',2)::uuid
                else split_part(c.conv_key,':',1)::uuid end as peer_id
         from convs c)
  select pm.conv_key, pm.peer_id, u.username,
         case when lm.recalled then '（已撤回）' else coalesce(nullif(lm.text,''), lm.file_name) end,
         lm.ts,
         (select count(*)::int from mine m2 where m2.conv_key=pm.conv_key and m2.to_id=me and m2.read_at is null and not m2.recalled),
         exists(select 1 from public.blocks b where b.user_id=me and b.blocked_id=pm.peer_id),
         exists(select 1 from public.blocks b where b.user_id=pm.peer_id and b.blocked_id=me)
  from peer_map pm
  join public.users u on u.id=pm.peer_id
  left join lastmsg lm on lm.conv_key=pm.conv_key
  order by lm.ts desc nulls last;
end;
$$;

create or replace function public.get_unread()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); total int; byconv jsonb;
begin
  select count(*)::int into total from public.dms where to_id=me and read_at is null and not recalled;
  select jsonb_object_agg(conv_key, cnt) into byconv from (
    select conv_key, count(*)::int as cnt from public.dms
      where to_id=me and read_at is null and not recalled group by conv_key) s;
  return jsonb_build_object('total', coalesce(total,0), 'byConv', coalesce(byconv,'{}'));
end;
$$;

-- ================= 管理后台查询 =================
create or replace function public.admin_users()
returns table(id uuid, username text, role text, status text, muted_until bigint, created_at bigint, approved_at bigint)
language sql stable security definer set search_path = public as $$
  select id, username, role, status, muted_until, created_at, approved_at
  from public.users where public.is_admin() order by created_at desc;
$$;

create or replace function public.admin_rooms()
returns table(id uuid, name text, type text, member_count int, message_count int, announce text, created_at bigint)
language sql stable security definer set search_path = public as $$
  select r.id, r.name, r.type, coalesce(array_length(r.members,1),0),
    (select count(*) from public.messages m where m.room_id=r.id), r.announce, r.created_at
  from public.rooms r where public.is_mod_plus() order by r.created_at desc;
$$;

create or replace function public.admin_messages(q text default '', room_filter uuid default null)
returns table(room_id uuid, room_name text, id uuid, nick text, text text, recalled bool, ts bigint)
language sql stable security definer set search_path = public as $$
  select m.room_id, r.name, m.id, m.nick, m.text, m.recalled, m.ts
  from public.messages m join public.rooms r on r.id=m.room_id
  where public.is_mod_plus() and (q='' or m.text ilike '%'||q||'%')
    and (room_filter is null or m.room_id=room_filter)
  order by m.ts desc limit 200;
$$;

create or replace function public.admin_dms(q text default '')
returns table(conv_key text, from_name text, to_name text, text text, file_name text, recalled bool, ts bigint)
language sql stable security definer set search_path = public as $$
  select m.conv_key,
    (select username from public.users a where a.id=m.from_id),
    (select username from public.users b where b.id=m.to_id),
    m.text, m.file_name, m.recalled, m.ts
  from public.dms m
  where public.is_admin() and (q='' or m.text ilike '%'||q||'%'
    or exists(select 1 from public.users u where u.id in (m.from_id,m.to_id) and u.username ilike '%'||q||'%'))
  order by m.ts desc limit 200;
$$;

create or replace function public.admin_reports()
returns table(id uuid, kind text, reporter_name text, room_name text, conv_key text, message jsonb, reason text, status text, created_at bigint)
language sql stable security definer set search_path = public as $$
  select r.id, r.kind,
    (select username from public.users where id=r.reporter_id),
    (select name from public.rooms where id=r.room_id),
    r.conv_key,
    (case when r.kind='dm'
        then (select to_jsonb(d) from public.dms d where d.id=r.message_id)
        else (select to_jsonb(m) from public.messages m where m.id=r.message_id) end),
    r.reason, r.status, r.created_at
  from public.reports r where public.is_mod_plus() order by r.created_at desc;
$$;

create or replace function public.admin_audit()
returns table(ts bigint, actor_name text, action text, target text, detail text)
language sql stable security definer set search_path = public as $$
  select ts, actor_name, action, target, detail from public.audit
  where public.is_admin() order by ts desc limit 300;
$$;

-- ============================================================
-- rpc_patch.sql
-- ============================================================
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
