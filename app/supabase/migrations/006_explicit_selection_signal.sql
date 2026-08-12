-- 006 — 使用者親手指出來的難點，接進同一條訊號管線
--
-- 框選不是新的輸入來源，而是既有訊號的**最強一級**；反過來，「點了 app 標的詞
-- 說想學」是最弱的一級。四級都是同一條管線上的深淺：
--   saved    點了 app 標的詞想學（**沒有倒帶**）        ← 這一版新增
--   weak     倒帶了
--   strong   倒帶 + 10 秒內開了逐字稿
--   selected 倒帶 + 開稿 + 親手指出是哪幾個字           ← 這一版新增
--
-- selection_kind 另外多一個 'segmentation'：「我聽不出這裡有幾個字」。它是使用者
-- **意圖**而不是診斷結果——app 判斷「難在哪」是 difficulty_items.type 的事，這一欄
-- 記的是學習者自己講的「我連把聲音切成詞都做不到」（Field 2003 的詞界切分失敗）。
-- 那一列的 selection_text 是**整句**，因為斷點的位置本來就不在某個詞上。
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
  check (strength in ('saved', 'weak', 'strong', 'selected'));

-- trigger_source 不必為 'saved' 加值：那條路徑**不建 replay event**（他沒有倒帶，
-- 寫一筆事件就是在資料庫裡捏造一次從未發生的重聽）。所以查詢時要記得，captures
-- 裡的 'saved' 列在 replay_events 沒有對應——那不是資料遺失，是它的定義。
-- 'segmentation' 也不必加值：它走既有的 'select'，因為它就是一次框選。
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

-- 'vocab' = 框了一個詞；'grammar' = 框了一個句型；
-- 'segmentation' = 「我聽不出這裡有幾個字」。
--
-- 刻意不重用 difficulty_items.type 的六個值（vocab/linking/speed/grammar/
-- accent/culture）：那六個是**診斷結果**（app 判斷難在哪），這一欄是**使用者
-- 意圖**（我要學的是詞還是句型）。兩者可以不一致——使用者圈了一個詞、診斷卻
-- 認為真正的難點是連音——那個不一致本身就是有價值的資料，合併欄位會把它抹掉。
--
-- 'segmentation' 是同一個道理的極端情形，也是這張表最值得收的一格：其餘兩個值
-- 的前提都是「他知道自己漏聽的是哪個詞」，而詞界切分失敗正是那個前提不成立的
-- 時候——他根本沒把那串聲音切成詞，框不出範圍。它仍然是使用者意圖（他主動說
-- 「這裡我切不出來」）而非診斷結果（app 沒有判斷任何事）。⚠️ 這一種的
-- selection_text 等於整句、與 transcript_text 相同，那是正確的：斷點的位置本來
-- 就不在某個詞上。讀這一欄的人必須先看 kind，否則會把它誤當成「框了一整句」。
alter table public.captures
  add column if not exists selection_kind text;
alter table public.captures
  drop constraint if exists captures_selection_kind_check;
alter table public.captures
  add constraint captures_selection_kind_check
  check (selection_kind is null or selection_kind in ('vocab', 'grammar', 'segmentation'));

-- 詞庫頁要「照時間倒序列出我框過的東西」，這是它唯一的查詢形狀。
-- partial 條件維持 `selection_kind is not null`：它自動涵蓋 segmentation（那也是
-- 使用者框的），而涵蓋不到 strength 'saved'（沒有 kind）——那正是要的結果，
-- 'saved' 的詞是 app 標出來的、他只是收下，不屬於「我框過的東西」。
create index if not exists captures_user_selected_idx
  on public.captures (user_id, created_at desc)
  where selection_kind is not null;

-- RLS：captures 的政策是 FOR ALL + auth.uid() = user_id，新欄位自動被涵蓋，
-- 不需要新政策。
