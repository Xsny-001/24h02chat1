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
