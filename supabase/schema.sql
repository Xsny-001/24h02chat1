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
