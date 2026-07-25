/**
 * Shared domain types for the W2 core loop:
 * rewind 訊號 → capture → 逐字稿 → 診斷 → 每日練習（SRS）。
 *
 * These shapes mirror the Supabase schema in
 * `supabase/migrations/001_init.sql` (captures / difficulty_items) so
 * best-effort sync is a plain column-for-field upsert.
 */

export type CaptureStrength = 'weak' | 'strong';

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
