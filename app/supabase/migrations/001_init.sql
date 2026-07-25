-- =============================================================================
-- Echo — 001_init.sql
-- Phase 1 MVP schema（依 docs/01-product/mvp-spec.md 資料模型草稿）
--
-- 表：episodes · replay_events · captures · difficulty_items
--     · practice_sessions · voice_profiles
--
-- ⚠️ MVP 開發期先不開 auth：所有表的 user_id 為 nullable uuid（之後接
--    auth.users），RLS 先開放 anon insert/select 讓 Expo Go demo 能直接寫。
--    TODO(上線前)：收緊所有 policy 到 auth.uid() = user_id。
-- ℹ️ episode id 為 text（client 產生：demo UUID 字串 / RSS guid 雜湊 `rss-*`）。
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- episodes：podcast metadata、audio_url、transcript 快取
-- -----------------------------------------------------------------------------
create table if not exists public.episodes (
  id              text primary key,   -- client 自帶：demo UUID / RSS `rss-<hash>`
  podcast_title   text,
  title           text not null,
  audio_url       text not null,
  duration_sec    integer,
  rss_guid        text,               -- RSS item guid（去重用）
  feed_url        text,
  transcript_url  text,               -- podcast:transcript srt/vtt url
  transcript_type text
                  check (transcript_type is null or transcript_type in ('srt', 'vtt')),
  transcript      jsonb,              -- 快取：podcast:transcript 或 Whisper 結果
  published_at    timestamptz,
  created_at      timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- voice_profiles：onboarding 60–90s 錄音 → Fish Audio voice_id / IndexTTS 參考
-- -----------------------------------------------------------------------------
create table if not exists public.voice_profiles (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid,            -- TODO: references auth.users(id) 當 auth 上線
  sample_audio_path  text,            -- Storage 路徑（onboarding 短文錄音）
  fish_voice_id      text,            -- Fish Audio reference_id（production TTS）
  status             text not null default 'pending'
                     check (status in ('pending', 'ready', 'failed')),
  created_at         timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- replay_events：核心訊號。螢幕 back-15s / 耳機遙控 / 鎖屏，全走同一張表
-- （Phase 2 真實生活模式 = 換 trigger_source，管線零改動）
-- -----------------------------------------------------------------------------
create table if not exists public.replay_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid,               -- TODO: references auth.users(id)
  episode_id      text not null references public.episodes(id) on delete cascade,
  from_pos        double precision not null,   -- 秒
  to_pos          double precision not null,   -- 秒
  playback_rate   double precision not null default 1.0,
  trigger_source  text not null default 'screen'
                  check (trigger_source in ('screen', 'headphone', 'lockscreen')),
  created_at      timestamptz not null default now()
);

create index if not exists replay_events_episode_created_idx
  on public.replay_events (episode_id, created_at desc);

-- -----------------------------------------------------------------------------
-- captures：replay 事件聚合出的擷取窗口（W2 起由 client 端 captureEngine 生成，
-- id 由 client 產 UUID 後 upsert，欄位 1:1 對齊 app/lib/types.ts 的 Capture）
-- 狀態機：pending →（用戶確認）confirmed / dismissed → practiced
-- -----------------------------------------------------------------------------
create table if not exists public.captures (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid,
  episode_id       text not null references public.episodes(id) on delete cascade,
  replay_event_id  uuid references public.replay_events(id) on delete set null,
  window_start     double precision not null,  -- 難點窗口 [T-15, T]（秒）
  window_end       double precision not null,
  context_start    double precision not null,  -- 窗口前後各 +6s（練習時重播用）
  context_end      double precision not null,
  strength         text not null default 'weak'
                   check (strength in ('weak', 'strong')),
  status           text not null default 'pending'
                   check (status in ('pending', 'confirmed',
                                     'dismissed', 'practiced')),
  transcript_text  text,                       -- 窗口內對齊後的句子（Whisper）
  diagnosis        jsonb,                      -- Claude 診斷 {type, focus_phrase,
                                               --   explanation_zh, practice_tip_zh}
  audio_clip_path  text,                       -- Storage 音檔切片路徑（W3+）
  created_at       timestamptz not null default now()
);

create index if not exists captures_status_idx on public.captures (status);

-- -----------------------------------------------------------------------------
-- difficulty_items：SRS 狀態（簡化 SM-2，欄位對齊 app/lib/srs.ts）
-- 一個 confirmed capture 對應一張卡 → capture_id 唯一，client upsert on conflict
-- -----------------------------------------------------------------------------
create table if not exists public.difficulty_items (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid,
  capture_id     uuid unique references public.captures(id) on delete cascade,
  type           text
                 check (type is null or type in ('vocab', 'linking', 'speed',
                                                 'grammar', 'accent', 'culture')),
  content        jsonb,           -- 卡片素材、自聲 TTS 路徑…（W3+）
  ease           numeric not null default 2.5,
  interval_days  integer not null default 0,
  due_date       date,
  reps           integer not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists difficulty_items_due_idx on public.difficulty_items (due_date);

-- -----------------------------------------------------------------------------
-- practice_sessions：daily session 完成情況（北極星指標來源）
-- -----------------------------------------------------------------------------
create table if not exists public.practice_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid,
  session_date     date not null default current_date,
  items_total      integer not null default 0,
  items_completed  integer not null default 0,
  completion_rate  real,
  duration_sec     integer,
  created_at       timestamptz not null default now()
);

-- =============================================================================
-- RLS — MVP 開發期 policy
-- ⚠️ TODO(上線前)：移除以下 anon 全開 policy，改為
--    `using (auth.uid() = user_id)` / `with check (auth.uid() = user_id)`，
--    並將 user_id 改 not null + FK 到 auth.users。
-- =============================================================================

alter table public.episodes          enable row level security;
alter table public.voice_profiles    enable row level security;
alter table public.replay_events     enable row level security;
alter table public.captures          enable row level security;
alter table public.difficulty_items  enable row level security;
alter table public.practice_sessions enable row level security;

-- episodes：demo 期 anon 可讀，且 rememberEpisode 的 upsert 需要 insert+update
-- 兩個 policy（RSS 單集在選集當下 upsert，讓 replay_events/captures FK 成立）
create policy "mvp dev: anon read episodes"
  on public.episodes for select to anon using (true);
create policy "mvp dev: anon insert episodes"
  on public.episodes for insert to anon with check (true);
create policy "mvp dev: anon update episodes"
  on public.episodes for update to anon using (true) with check (true);

-- replay_events：demo 核心 —— anon 可寫可讀
create policy "mvp dev: anon insert replay_events"
  on public.replay_events for insert to anon with check (true);
create policy "mvp dev: anon read replay_events"
  on public.replay_events for select to anon using (true);

-- captures / difficulty_items / practice_sessions / voice_profiles：
-- W2+ 的 client 流程會用到，先一併開 anon 讀寫，同樣上線前收緊
create policy "mvp dev: anon insert captures"
  on public.captures for insert to anon with check (true);
create policy "mvp dev: anon read captures"
  on public.captures for select to anon using (true);
create policy "mvp dev: anon update captures"
  on public.captures for update to anon using (true) with check (true);

create policy "mvp dev: anon insert difficulty_items"
  on public.difficulty_items for insert to anon with check (true);
create policy "mvp dev: anon read difficulty_items"
  on public.difficulty_items for select to anon using (true);
create policy "mvp dev: anon update difficulty_items"
  on public.difficulty_items for update to anon using (true) with check (true);

create policy "mvp dev: anon insert practice_sessions"
  on public.practice_sessions for insert to anon with check (true);
create policy "mvp dev: anon read practice_sessions"
  on public.practice_sessions for select to anon using (true);

create policy "mvp dev: anon insert voice_profiles"
  on public.voice_profiles for insert to anon with check (true);
create policy "mvp dev: anon read voice_profiles"
  on public.voice_profiles for select to anon using (true);

-- =============================================================================
-- Seed：兩集 demo episode（UUID 與 app/lib/episodes.ts 硬編值一致，
-- 讓 replay_events 的 FK 在 demo 期就成立）
-- =============================================================================

insert into public.episodes (id, podcast_title, title, audio_url, duration_sec)
values
  ('11111111-1111-4111-8111-111111111111',
   'Planet Money (NPR)',
   'Seven allegedly fake Chanel bags vs The RealReal',
   'https://npr.simplecastaudio.com/43b5acee-463e-4612-95ad-d2596d9dd337/episodes/a5a22e7a-4cac-46c1-b29b-d5dbebba9027/audio/128/default.mp3?awCollectionId=43b5acee-463e-4612-95ad-d2596d9dd337&awEpisodeId=a5a22e7a-4cac-46c1-b29b-d5dbebba9027&feed=hvWWWzRv',
   1538),
  ('22222222-2222-4222-8222-222222222222',
   'LibriVox Audiobook',
   'The Art of War — Ch. 1–2 (Sun Tzu)',
   'https://archive.org/download/art_of_war_librivox/art_of_war_01-02_sun_tzu_64kb.mp3',
   506)
on conflict (id) do nothing;
