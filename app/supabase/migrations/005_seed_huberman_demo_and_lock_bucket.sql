-- =============================================================================
-- Echo — 005_seed_huberman_demo_and_lock_bucket.sql
--
-- ① Huberman 示範集的 seed row。replay_events / captures 都有 episode FK，
--    少了這筆，使用者在這集按返回鍵的 insert 會失敗 —— 而那正是產品唯一在乎的
--    強訊號，不能靜靜地掉。id 與 app/lib/episodes.ts 的 DEMO_EPISODES 對齊。
--
-- ② 收回 004 開的上傳權限。匿名註冊是開放的（ADR-0013），留著 insert policy
--    等於讓任何人往這個專案丟檔案。demo-media 從此只讀不寫。
-- =============================================================================

insert into public.episodes (id, podcast_title, title, audio_url, duration_sec,
                             transcript_url, transcript_type)
values (
  '33333333-3333-4333-8333-333333333333',
  'Huberman Lab Essentials',
  'Understand & Improve Memory Using Science-Based Tools',
  'https://lkywohepzbubiijxktai.supabase.co/storage/v1/object/public/demo-media/huberman-memory/audio.mp3',
  2149,
  'https://lkywohepzbubiijxktai.supabase.co/storage/v1/object/public/demo-media/huberman-memory/sentences.vtt',
  'vtt'
)
on conflict (id) do update
  set transcript_url = excluded.transcript_url,
      transcript_type = excluded.transcript_type,
      audio_url = excluded.audio_url,
      duration_sec = excluded.duration_sec;

drop policy if exists "demo_media_temp_upload" on storage.objects;
