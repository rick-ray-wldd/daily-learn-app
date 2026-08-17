-- 007 — 攤位問卷的收件匣
--
-- `design/booth-form.html` 直接從瀏覽器 POST 到 PostgREST。送出的人**沒有登入**，
-- 用的是 publishable anon key（它本來就被打進 app 的 JS bundle 送到每台裝置，
-- 所以出現在一個公開網頁上不是新的暴露）。
--
-- 真正的保護在這一份 migration：**只開 INSERT，不開 SELECT。**
-- 拿到那把 key 的人可以送出一筆問卷，但讀不到任何人的答案——包含他自己剛送的那筆
-- （所以表單用 `Prefer: return=minimal`，不要求回傳）。
--
-- ⚠️ 這張表與 `captures` / `replay_events` 是**完全分開的世界**：
-- 那些表的每一列都綁 owner（ADR-0013），這一張沒有 owner 可綁——填表的人不是
-- app 的使用者。不要為了「統一」把它塞進同一套 RLS，那會逼你放寬別的表。

create table if not exists public.booth_signups (
  id            uuid primary key default gen_random_uuid(),
  -- 伺服器時間。`submitted_at` 是瀏覽器給的，兩個都留：對不上就是裝置時鐘不準，
  -- 而那件事本身值得知道（會影響 app 端所有以當地日界線為準的邏輯）。
  created_at    timestamptz not null default now(),

  form_version  text,
  -- 他是從哪張 QR 進來的（海報 / demo 後 / 其他）。這一欄是分組的依據，
  -- 沒有它就沒辦法比較「只看過海報」與「看過 demo」兩群人的回答。
  src           text,
  submitted_at  timestamptz,
  -- 'zh' | 'en'：他把表單切成哪一種語言。這本身是個訊號。
  lang          text,

  email         text not null,
  consent       boolean not null,
  interview_ok  boolean not null default false,

  -- Q1–Q9 的答案。用 jsonb 而不是九個欄位：題目還會改，而改題目不該要求改 schema。
  answers       jsonb
);

-- email 不設 unique：同一個人在攤位上填兩次（換了語言、或想改答案）是真實情境，
-- 擋掉他只會讓他當場放棄。重複的在分析時去重，不要在寫入時擋。
create index if not exists booth_signups_created_at_idx on public.booth_signups (created_at desc);
create index if not exists booth_signups_src_idx        on public.booth_signups (src);

alter table public.booth_signups enable row level security;

-- 匿名可以投稿，但**看不到任何東西**。
-- 沒有 SELECT / UPDATE / DELETE policy = 那三個動作對 anon 一律拒絕。
drop policy if exists "anon can submit" on public.booth_signups;
create policy "anon can submit"
  on public.booth_signups
  for insert
  to anon
  with check (true);

-- 讀取只走 service_role（Supabase 主控台、或你自己的分析腳本）。
-- service_role 本來就繞過 RLS，這裡不需要 policy——寫下來只是為了讓「誰讀得到」
-- 這件事在檔案上讀得出來，而不是靠記憶。
