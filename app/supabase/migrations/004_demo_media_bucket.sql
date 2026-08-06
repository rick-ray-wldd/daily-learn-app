-- =============================================================================
-- Echo — 004_demo_media_bucket.sql
--
-- 示範單集的素材（音檔 + 對齊好的句子級 vtt）放這個 bucket。理由與界線見
-- docs/adr/0014-manufactured-demo-transcripts.md —— 重點：這是 **prototype 的
-- 示範素材**，不是產品內容管線，不能拿去放正式節目的音檔。
--
-- 公開讀：app 播音檔與抓 vtt 都是無 auth header 的裸 fetch（expo-audio 播 URL、
-- transcript.ts 的 fetchRssTranscript），私有 bucket 得靠會過期的 signed URL，
-- 對示範素材不值得。
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('demo-media', 'demo-media', true, 62914560,
        array['audio/mpeg', 'text/vtt', 'text/plain'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 上傳期間才需要的寫入權限，由 005 收回。要再加素材就重跑這段、傳完再 drop。
drop policy if exists "demo_media_temp_upload" on storage.objects;
create policy "demo_media_temp_upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'demo-media');
