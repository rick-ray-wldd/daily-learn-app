-- =============================================================================
-- Echo — 002_auth_rls.sql
--
-- 兌現 001_init.sql 的 `TODO(上線前)`：把 anon 全開的 dev policy 換成
-- `auth.uid() = user_id`。觸發點是「發 TestFlight 給 10 位外部 beta 使用者」——
-- 那就是 001 註解裡說的「上線前」。
--
-- 三件事一起做：
--   1. user_id 補上 default auth.uid() + FK 到 auth.users
--   2. RLS policy 全部改成 authenticated + 只看得到自己的 row
--   3. api_usage + consume_api_quota()：Edge Function 的每人每日用量上限
--
-- 前置：Supabase Dashboard → Authentication → Providers 需開啟
--       **Anonymous sign-ins**（app 啟動時呼叫 signInAnonymously）。
--
-- ⚠️ 舊有 user_id 為 NULL 的 demo 資料不會被刪除，但在新 policy 下不再可讀
--    （NULL = auth.uid() 結果是 NULL，不成立）。這是刻意的：不在 migration
--    裡刪任何人的資料，孤兒 row 就讓它靜靜躺著。
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. user_id：預設帶入呼叫者、並綁到 auth.users
-- -----------------------------------------------------------------------------
alter table public.voice_profiles
  alter column user_id set default auth.uid();
alter table public.replay_events
  alter column user_id set default auth.uid();
alter table public.captures
  alter column user_id set default auth.uid();
alter table public.difficulty_items
  alter column user_id set default auth.uid();
alter table public.practice_sessions
  alter column user_id set default auth.uid();

alter table public.voice_profiles
  add constraint voice_profiles_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.replay_events
  add constraint replay_events_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.captures
  add constraint captures_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.difficulty_items
  add constraint difficulty_items_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.practice_sessions
  add constraint practice_sessions_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- 北極星指標是「每位活躍使用者每週完成的 daily session 數」——按 user 撈。
create index if not exists replay_events_user_created_idx
  on public.replay_events (user_id, created_at desc);
create index if not exists captures_user_status_idx
  on public.captures (user_id, status);
create index if not exists difficulty_items_user_due_idx
  on public.difficulty_items (user_id, due_date);
create index if not exists practice_sessions_user_date_idx
  on public.practice_sessions (user_id, session_date desc);

-- -----------------------------------------------------------------------------
-- 2. 移除 001 的 anon dev policy
-- -----------------------------------------------------------------------------
drop policy if exists "mvp dev: anon read episodes"            on public.episodes;
drop policy if exists "mvp dev: anon insert episodes"          on public.episodes;
drop policy if exists "mvp dev: anon update episodes"          on public.episodes;
drop policy if exists "mvp dev: anon insert replay_events"     on public.replay_events;
drop policy if exists "mvp dev: anon read replay_events"       on public.replay_events;
drop policy if exists "mvp dev: anon insert captures"          on public.captures;
drop policy if exists "mvp dev: anon read captures"            on public.captures;
drop policy if exists "mvp dev: anon update captures"          on public.captures;
drop policy if exists "mvp dev: anon insert difficulty_items"  on public.difficulty_items;
drop policy if exists "mvp dev: anon read difficulty_items"    on public.difficulty_items;
drop policy if exists "mvp dev: anon update difficulty_items"  on public.difficulty_items;
drop policy if exists "mvp dev: anon insert practice_sessions" on public.practice_sessions;
drop policy if exists "mvp dev: anon read practice_sessions"   on public.practice_sessions;
drop policy if exists "mvp dev: anon insert voice_profiles"    on public.voice_profiles;
drop policy if exists "mvp dev: anon read voice_profiles"      on public.voice_profiles;

-- -----------------------------------------------------------------------------
-- 3. episodes：共享的 podcast 目錄，沒有 user_id
--    每個人聽的可能是同一集，所以全體 authenticated 可讀；client 端選集時會
--    upsert RSS 單集（讓 replay_events / captures 的 FK 成立），所以也要能寫。
--    注意這代表 beta 使用者彼此看得到、也能覆寫 episode metadata——這裡沒有
--    個人資料，可接受；真的要收緊得等 episodes 有 owner 概念。
-- -----------------------------------------------------------------------------
create policy "episodes readable by signed-in users"
  on public.episodes for select to authenticated using (true);
create policy "episodes insertable by signed-in users"
  on public.episodes for insert to authenticated with check (true);
create policy "episodes updatable by signed-in users"
  on public.episodes for update to authenticated using (true) with check (true);

-- -----------------------------------------------------------------------------
-- 4. 個人資料表：只看得到、只寫得進自己的 row
-- -----------------------------------------------------------------------------
create policy "own replay_events"
  on public.replay_events for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own captures"
  on public.captures for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own difficulty_items"
  on public.difficulty_items for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own practice_sessions"
  on public.practice_sessions for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "own voice_profiles"
  on public.voice_profiles for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- =============================================================================
-- 5. Edge Function 用量配額
--
-- 為什麼需要：把 provider key 搬到 Edge Function（ADR-0008）擋掉的是「key 被
-- 挖走」，擋不住「有人一直呼叫」。匿名註冊是開放的（Supabase 對 IP 限 30
-- 次/小時），所以光靠 auth 仍不足以保護 Anthropic / OpenAI 帳單——這張表才是。
-- =============================================================================

create table if not exists public.api_usage (
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('diagnose', 'transcribe')),
  usage_date  date not null default current_date,
  count       integer not null default 0,
  primary key (user_id, kind, usage_date)
);

alter table public.api_usage enable row level security;
-- 刻意不建任何 policy：只有 SECURITY DEFINER 函式與 service_role 碰得到，
-- client 一律讀不到寫不到。

/**
 * 原子地「檢查並累加」某使用者今天某類呼叫的次數。
 *
 * 用 `on conflict do update ... where count < limit` 讓檢查與累加發生在同一個
 * statement：兩個併發請求不可能同時通過上限檢查。超過上限時 UPDATE 不作用，
 * RETURNING 不吐 row，於是 v_count 為 NULL —— 那就是「拒絕」。
 */
create or replace function public.consume_api_quota(
  p_user_id uuid,
  p_kind    text,
  p_limit   integer
)
returns table (allowed boolean, used integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.api_usage as u (user_id, kind, usage_date, count)
  values (p_user_id, p_kind, current_date, 1)
  on conflict (user_id, kind, usage_date) do update
    set count = u.count + 1
    where u.count < p_limit
  returning u.count into v_count;

  if v_count is null then
    select a.count into v_count
      from public.api_usage a
     where a.user_id = p_user_id
       and a.kind = p_kind
       and a.usage_date = current_date;
    return query select false, coalesce(v_count, 0);
  end if;

  return query select true, v_count;
end;
$$;

-- 只有 Edge Function（service_role key）叫得動。
revoke all on function public.consume_api_quota(uuid, text, integer) from public;
revoke all on function public.consume_api_quota(uuid, text, integer) from anon;
revoke all on function public.consume_api_quota(uuid, text, integer) from authenticated;
grant execute on function public.consume_api_quota(uuid, text, integer) to service_role;
