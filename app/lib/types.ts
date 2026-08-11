/**
 * Shared domain types for the W2 core loop:
 * rewind 訊號 → capture → 逐字稿 → 診斷 → 每日練習（SRS）。
 *
 * These shapes mirror the Supabase schema in
 * `supabase/migrations/001_init.sql` (captures / difficulty_items) so
 * best-effort sync is a plain column-for-field upsert.
 */

/**
 * 訊號強度三級。**它們是同一條管線上的深淺，不是三種來源**（ADR-0003）：
 *
 *   weak      倒帶了（可能只是分心，練習頁的 confirm 步驟負責過濾）
 *   strong    倒帶 + 10 秒內降速或打開逐字稿
 *   selected  倒帶 + 開稿 + 親手圈出是哪幾個字   ← migration 006
 *
 * 加 `selected` 而不是新開一個型別，是因為框選產生的東西在下游（診斷、SRS、
 * 每日 session）跟倒帶產生的東西行為完全一樣；分家只會讓每個查詢都要處理兩種
 * 形狀。⚠️ 三態之後，任何 `=== 'strong'` 的二分法都要重新檢查 else 分支——
 * `selected` 是最強的一級，掉進「弱訊號」那一邊會是錯的。
 */
export type CaptureStrength = 'weak' | 'strong' | 'selected';

/**
 * 使用者**意圖**：他框的是一個詞還是一個句型。
 *
 * 刻意不重用 DiagnosisType 的六個值——那六個是 app 的**判斷結果**，這一個是
 * 學習者自己說的。兩者可以不一致（他圈了一個詞、診斷卻認為真正的難點是連音），
 * 而那個不一致本身就是有價值的資料，合併欄位會把它抹掉（migration 006）。
 */
export type SelectionKind = 'vocab' | 'grammar';

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
   * 學習者親手框出來的那幾個字。只有 strength === 'selected' 時才有。
   *
   * 跟 `transcript_text` 分開存：後者是整句上下文（診斷需要），這裡是句子
   * **裡面**的一小段。沒有這一欄，Claude 只能重新猜一次「難在哪」——而那正是
   * 框選要消滅的不確定性。
   */
  selection_text?: string;
  /** 他說那是詞還是句型。與 diagnosis.type 刻意分開，見 SelectionKind。 */
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
  weak_count: number;
  dismissed_count: number;
  created_at: string; // ISO 8601
}
