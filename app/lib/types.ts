/**
 * Shared domain types for the W2 core loop:
 * rewind 訊號 → capture → 逐字稿 → 診斷 → 每日練習（SRS）。
 *
 * These shapes mirror the Supabase schema in
 * `supabase/migrations/001_init.sql` (captures / difficulty_items) so
 * best-effort sync is a plain column-for-field upsert.
 */

/**
 * 訊號強度四級。**它們是同一條管線上的深淺，不是四種來源**（ADR-0003）：
 *
 *   saved     點了 app 標的詞說想學   ← 沒有理解斷點，最弱
 *   weak      倒帶了（可能只是分心，練習頁的 confirm 步驟負責過濾）
 *   strong    倒帶 + 10 秒內降速或打開逐字稿
 *   selected  倒帶 + 開稿 + 親手指出是哪幾個字
 *
 * `saved` 與其餘三級有一道質的差別，不只是量的差別：另外三級背後都有一次真的
 * 發生過的倒帶，`saved` 沒有。所以它可以進練習佇列（那是「他想學什麼」），
 * **但不准進任何訊號指標**（那是「他哪裡聽不懂」）。這個 repo 已經在 `selected`
 * 上犯過兩次同樣的錯，兩次都是因為指標用「排除某一級」的黑名單寫法。
 *
 * ⚠️ 任何以 strength 分岔的地方一律用**白名單**（明列吃哪幾級），不准用
 * `!== 'weak'` / `!== 'selected'`：黑名單讓新增的級別預設被算進去，而預設
 * 算進去的代價是產品唯一的論點（這些數字是真的）當場失效。
 */
export type CaptureStrength = 'saved' | 'weak' | 'strong' | 'selected';

/**
 * 使用者**意圖**：他框的是一個詞還是一個句型。
 *
 * 刻意不重用 DiagnosisType 的六個值——那六個是 app 的**判斷結果**，這一個是
 * 學習者自己說的。兩者可以不一致（他圈了一個詞、診斷卻認為真正的難點是連音），
 * 而那個不一致本身就是有價值的資料，合併欄位會把它抹掉（migration 006）。
 *
 * 'segmentation' = 「我聽不出這裡有幾個字」。它與另外兩個不同：不是「我要學這個」
 * 而是「我連把聲音切成詞都做不到」（Field 2003 的詞界切分失敗）。這一級的
 * selection_text 是**整句**，因為斷點的位置本來就不在某個詞上——市面上沒有 app
 * 收得到這個資料，它是這個產品獨有的那一格。
 */
export type SelectionKind = 'vocab' | 'grammar' | 'segmentation';

export type CaptureStatus = 'pending' | 'confirmed' | 'dismissed' | 'practiced';

/** 六類難點分類（signal-design.md §5）。 */
export type DiagnosisType =
  | 'vocab'
  | 'linking'
  | 'speed'
  | 'grammar'
  | 'accent'
  | 'culture';

export interface Diagnosis {
  type: DiagnosisType;
  /** The exact word/phrase that likely caused the difficulty. */
  focus_phrase: string;
  /** 中文解釋，≤60 字。 */
  explanation_zh: string;
  /** 中文練習建議，≤40 字。 */
  practice_tip_zh: string;
  /**
   * **`focus_phrase`** 這個片語在這句話裡的中文簡義，≤8 字（= `liveActivity.ts` 的
   * `OPTION_LABEL_MAX_CHARS`，鎖屏一列要塞三顆按鈕）。
   *
   * ⚠️ 它回答的是 `focus_phrase`，**不是** `selection_text`。兩者可以指向不同的詞
   * （`diagnoseCapture` 只收 sentence/context，selection_text 從來沒進過診斷），
   * 所以任何拿它當正解的題目，題面**只能**是 `focus_phrase`。這條規則落在
   * `liveActivity.ts` 的 `buildCard`。
   *
   * optional 是必要的，而且**缺 ≠ 空字串**：舊 capture 根本沒有這一欄，缺代表
   * 「還沒生成」。任何讀取端一律當 optional 讀，絕不可以把它加進
   * `validateDiagnosis` 的 reject 條件——那會讓既有的 diagnosis 整筆作廢。
   *
   * ⚠️ 它**不是** `explanation_zh` 的縮寫。`explanation_zh` 是「為什麼這句難」的
   * ≤60 字說明；拿它當三選一的正解，會變成正解 60 字、干擾項 5 字，光看長度就能
   * 選對——測驗當場失效，卻會產出一個很漂亮的假正確率。
   */
  gloss_zh?: string;
  /**
   * 與 `gloss_zh` 語義上明確不同的干擾項，每個 ≤8 字。缺 = 還沒生成。
   *
   * 由 `diagnose` Edge Function 預先生成（鎖定畫面的 intent 不能連網，現算不可能）。
   * **client 不重做長度／去重檢查**，那些守門的唯一規格來源是 `liveActivity.ts` 的
   * `buildCard`。
   *
   * ⚠️ server 端保證的**只有字面不重疊**（相等／互相包含），語義那一層靠的是一次
   * 盲測複核（`verifyQuizOptions`）——那是模型判斷，不是不變式。所以「絕對沒有第二個
   * 正解」這句話**沒有人保證得了**，不要據此在下游省掉防線。
   */
  distractors_zh?: string[];
}

export interface Capture {
  /** UUID v4 — doubles as the Supabase `captures.id` primary key. */
  id: string;
  episode_id: string;
  /** Difficulty window [T-15, T] in episode seconds (signal-design.md §4). */
  window_start: number;
  window_end: number;
  /** Window padded ±6s — what the practice screen actually replays. */
  context_start: number;
  context_end: number;
  strength: CaptureStrength;
  status: CaptureStatus;
  transcript_text?: string;
  diagnosis?: Diagnosis;
  /**
   * 學習者親手指出來的那一段。三種來源，看 `selection_kind` 分辨：
   *   vocab / grammar  他框出來的那幾個字
   *   segmentation     整句（他連詞界都切不出來，指不出更小的範圍）
   *   （沒有 kind）     strength 'saved'：app 標的琥珀詞，他按了加入練習
   *
   * 跟 `transcript_text` 分開存：後者是整句上下文（診斷需要），這裡是句子
   * **裡面**的一小段。沒有這一欄，Claude 只能重新猜一次「難在哪」——而那正是
   * 框選要消滅的不確定性。（segmentation 兩者相同不是冗餘：一個是上下文、
   * 一個是他指的範圍，讀的人靠 kind 才知道「整句」是他的答案而非預設值。）
   */
  selection_text?: string;
  /** 他說那是詞、句型、還是「根本切不出詞」。strength 'saved' 沒有這一欄——
   *  「詞還是句型」是 evaluation，聽的當下不問（見 TermSheet 檔頭）。 */
  selection_kind?: SelectionKind;
  created_at: string; // ISO 8601
}

/** Simplified SM-2 state, one item per confirmed capture. */
export interface SrsItem {
  capture_id: string;
  ease: number; // starts at 2.5
  interval_days: number;
  due_date: string; // YYYY-MM-DD (local)
  reps: number;
}

/** One Whisper verbose_json segment (sentence-ish chunk with timestamps). */
export interface TranscriptSegment {
  id: number;
  start: number; // seconds
  end: number; // seconds
  text: string;
}

/** Per-episode transcript cache pointer kept in the store. */
export interface TranscriptMeta {
  episode_id: string;
  status: 'done' | 'failed';
  /** FileSystem cache path of the transcript JSON when status === 'done'. */
  path?: string;
  /** Failure reason when status === 'failed' (e.g. file >25MB). */
  error?: string;
  updated_at: string; // ISO 8601
}

/** 已訂閱的 podcast feed（store `echo.feeds.v1`，key = feed_url）。 */
export interface Feed {
  feed_url: string; // canonical key
  title: string;
  author?: string;
  artwork_url?: string;
  itunes_collection_id?: number;
  subscribed_at: string; // ISO
  last_fetched_at?: string; // ISO
}

/** Daily practice session summary (北極星指標的本地來源). */
export interface PracticeRecord {
  date: string; // YYYY-MM-DD (local)
  items_total: number;
  items_completed: number;
  strong_count: number;
  /** **只數倒帶了一次的那一級**。'saved' 不在裡面——它背後沒有倒帶，混進來這個
   *  欄位就從「偵測到幾次重聽」變成「他練了幾張卡」。 */
  weak_count: number;
  /** 他標記想學的詞練了幾張。與上面兩格分開存是因為它不是訊號，只是意願。
   *  optional：這個欄位比既有的 practice log 晚出生，舊紀錄沒有它（缺 = 0，
   *  不是 0 也不是未知——那時候還沒有 'saved' 這一級）。 */
  saved_count?: number;
  dismissed_count: number;
  created_at: string; // ISO 8601
}
