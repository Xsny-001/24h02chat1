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
  update public.dms set recalled=true, recalled_by=(select username from public.users where id=auth.uid()) where id=mid and conv_key=conv;
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
