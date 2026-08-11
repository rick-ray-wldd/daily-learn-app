-- 006 — 使用者親手框選的難點，接進同一條訊號管線
--
-- 框選不是新的輸入來源，而是既有訊號的**最強一級**：
--   weak     倒帶了
--   strong   倒帶 + 10 秒內開了逐字稿
--   selected 倒帶 + 開稿 + 親手圈出是哪幾個字   ← 這一版新增
--
-- 所以 ADR-0003 的單一 replay-event 管線不變，只是多一種 trigger_source。
-- 沿用既有的 captures / replay_events，不開新表：框選產生的東西跟倒帶產生的
-- 東西在下游（診斷、SRS、每日 session）行為完全一樣，分表只會讓每個查詢都要
-- union 兩邊。

-- CHECK 約束不能就地擴充，只能先丟再建。兩張表的舊值都在新集合裡，所以不會有
-- 既有列被擋下來（重跑也安全）。
alter table public.captures
  drop constraint if exists captures_strength_check;
alter table public.captures
  add constraint captures_strength_check
  check (strength in ('weak', 'strong', 'selected'));

alter table public.replay_events
  drop constraint if exists replay_events_trigger_source_check;
alter table public.replay_events
  add constraint replay_events_trigger_source_check
  check (trigger_source in ('screen', 'headphone', 'lockscreen', 'select'));

-- 框選的是哪幾個字。
--
-- 為什麼要多存這個而不是只靠 transcript_text：transcript_text 是整個 15 秒窗口
-- 的句子，框選是窗口**裡面**的一小段。診斷要知道學習者指的是 "conditioned place
-- aversion" 這三個字，而不是整段話——沒有這一欄，Claude 只能重新猜一次，
-- 而「猜哪裡難」正是框選要消滅的那個不確定性。
alter table public.captures
  add column if not exists selection_text text;

-- 'vocab' = 框了一個詞；'grammar' = 框了一個句型。
--
-- 刻意不重用 difficulty_items.type 的六個值（vocab/linking/speed/grammar/
-- accent/culture）：那六個是**診斷結果**（app 判斷難在哪），這一欄是**使用者
-- 意圖**（我要學的是詞還是句型）。兩者可以不一致——使用者圈了一個詞、診斷卻
-- 認為真正的難點是連音——那個不一致本身就是有價值的資料，合併欄位會把它抹掉。
alter table public.captures
  add column if not exists selection_kind text;
alter table public.captures
  drop constraint if exists captures_selection_kind_check;
alter table public.captures
  add constraint captures_selection_kind_check
  check (selection_kind is null or selection_kind in ('vocab', 'grammar'));

-- 詞庫頁要「照時間倒序列出我框過的東西」，這是它唯一的查詢形狀。
create index if not exists captures_user_selected_idx
  on public.captures (user_id, created_at desc)
  where selection_kind is not null;

-- RLS：captures 的政策是 FOR ALL + auth.uid() = user_id，新欄位自動被涵蓋，
-- 不需要新政策。
