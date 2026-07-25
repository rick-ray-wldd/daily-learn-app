/**
 * Local persistence layer — AsyncStorage + in-memory cache + subscribe.
 *
 * Single source of truth for captures, SRS items, transcript cache pointers
 * and practice records. Deliberately tiny: no state-management library, just
 * `get*` / mutators / `subscribe`. Every mutation synchronously updates the
 * in-memory cache, notifies listeners, then fire-and-forgets:
 *   1. AsyncStorage persistence
 *   2. best-effort Supabase upsert (same pattern as lib/replay.ts — the app
 *      never waits on, nor fails because of, the network)
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { DEMO_EPISODES, Episode } from './episodes';
import { supabase } from './supabase';
import {
  Capture,
  Feed,
  PracticeRecord,
  SrsItem,
  TranscriptMeta,
} from './types';

const KEYS = {
  captures: 'echo.captures.v1',
  srs: 'echo.srs.v1',
  transcripts: 'echo.transcripts.v1',
  practice: 'echo.practice.v1',
  feeds: 'echo.feeds.v1',
  feedEpisodes: 'echo.feedEpisodes.v1',
  episodeIndex: 'echo.episodeIndex.v1',
} as const;

interface StoreState {
  captures: Capture[];
  srsItems: SrsItem[];
  transcripts: Record<string, TranscriptMeta>;
  practiceLog: PracticeRecord[];
  feeds: Feed[];
  /** key = feed_url，每 feed 最多 20 筆（lib/rss.ts 已截斷）。 */
  feedEpisodes: Record<string, Episode[]>;
  /**
   * 曾播放過的單集快照——capture 只會在播放中產生，所以有 capture 的單集
   * 必在 index；退訂 / feed 更新掉出前 20 集都不影響 Practice 回放。
   */
  episodeIndex: Record<string, Episode>;
}

const state: StoreState = {
  captures: [],
  srsItems: [],
  transcripts: {},
  practiceLog: [],
  feeds: [],
  feedEpisodes: {},
  episodeIndex: {},
};

let hydrated = false;
/** m13: 記憶化進行中的 hydrate，並發呼叫共用同一個 promise（防雙重 hydrate）。 */
let hydrating: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.warn('[store] listener error:', err);
    }
  });
}

/** Subscribe to any store change. Returns the unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function persist(key: string, value: unknown): void {
  AsyncStorage.setItem(key, JSON.stringify(value)).catch((err) =>
    console.warn(`[store] persist ${key} failed:`, err),
  );
}

function parseOr<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Load everything from AsyncStorage into memory. Safe to call repeatedly（並發亦安全）. */
export function initStore(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (!hydrating) {
    hydrating = hydrate().finally(() => {
      hydrating = null; // 完成後清掉；之後的呼叫走 hydrated 快路徑
    });
  }
  return hydrating;
}

async function hydrate(): Promise<void> {
  try {
    const entries = await AsyncStorage.multiGet([
      KEYS.captures,
      KEYS.srs,
      KEYS.transcripts,
      KEYS.practice,
      KEYS.feeds,
      KEYS.feedEpisodes,
      KEYS.episodeIndex,
    ]);
    const byKey = Object.fromEntries(entries);
    state.captures = parseOr<Capture[]>(byKey[KEYS.captures], []);
    state.srsItems = parseOr<SrsItem[]>(byKey[KEYS.srs], []);
    state.transcripts = parseOr<Record<string, TranscriptMeta>>(
      byKey[KEYS.transcripts],
      {},
    );
    state.practiceLog = parseOr<PracticeRecord[]>(byKey[KEYS.practice], []);
    state.feeds = parseOr<Feed[]>(byKey[KEYS.feeds], []);
    state.feedEpisodes = parseOr<Record<string, Episode[]>>(
      byKey[KEYS.feedEpisodes],
      {},
    );
    state.episodeIndex = parseOr<Record<string, Episode>>(
      byKey[KEYS.episodeIndex],
      {},
    );
  } catch (err) {
    console.warn('[store] hydrate failed (starting empty):', err);
  }
  hydrated = true;
  notify();
}

export function isHydrated(): boolean {
  return hydrated;
}

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

export function getCaptures(): Capture[] {
  return state.captures;
}

export function getCapture(id: string): Capture | undefined {
  return state.captures.find((c) => c.id === id);
}

/** Insert or replace a capture by id; persists and best-effort syncs. */
export function upsertCapture(capture: Capture): void {
  const idx = state.captures.findIndex((c) => c.id === capture.id);
  if (idx >= 0) state.captures[idx] = capture;
  else state.captures.unshift(capture);
  persist(KEYS.captures, state.captures);
  void syncCapture(capture);
  notify();
}

/** Shallow-merge a patch into an existing capture. Returns the new value. */
export function updateCapture(
  id: string,
  patch: Partial<Capture>,
): Capture | undefined {
  const idx = state.captures.findIndex((c) => c.id === id);
  if (idx < 0) return undefined;
  const next = { ...state.captures[idx], ...patch };
  state.captures[idx] = next;
  persist(KEYS.captures, state.captures);
  void syncCapture(next);
  notify();
  return next;
}

// ---------------------------------------------------------------------------
// SRS items
// ---------------------------------------------------------------------------

export function getSrsItems(): SrsItem[] {
  return state.srsItems;
}

export function getSrsItem(captureId: string): SrsItem | undefined {
  return state.srsItems.find((i) => i.capture_id === captureId);
}

/** Insert or replace an SRS item (keyed by capture_id). */
export function upsertSrsItem(item: SrsItem): void {
  const idx = state.srsItems.findIndex(
    (i) => i.capture_id === item.capture_id,
  );
  if (idx >= 0) state.srsItems[idx] = item;
  else state.srsItems.push(item);
  persist(KEYS.srs, state.srsItems);
  void syncSrsItem(item);
  notify();
}

// ---------------------------------------------------------------------------
// Transcript cache pointers
// ---------------------------------------------------------------------------

export function getTranscriptMeta(episodeId: string): TranscriptMeta | undefined {
  return state.transcripts[episodeId];
}

export function setTranscriptMeta(meta: TranscriptMeta): void {
  state.transcripts[meta.episode_id] = meta;
  persist(KEYS.transcripts, state.transcripts);
  notify();
}

// ---------------------------------------------------------------------------
// Feeds（訂閱）＋ per-feed episodes ＋ episodeIndex（已播放單集快照）
// ---------------------------------------------------------------------------

export function getFeeds(): Feed[] {
  return state.feeds;
}

export function getFeed(feedUrl: string): Feed | undefined {
  return state.feeds.find((f) => f.feed_url === feedUrl);
}

/** 冪等：feed_url 已存在 → 只更新 episodes 與 last_fetched_at（重複訂閱規則）。 */
export function addFeed(feed: Feed, episodes: Episode[]): void {
  const idx = state.feeds.findIndex((f) => f.feed_url === feed.feed_url);
  if (idx >= 0) {
    state.feeds[idx] = {
      ...state.feeds[idx],
      last_fetched_at: feed.last_fetched_at ?? new Date().toISOString(),
    };
  } else {
    state.feeds.push(feed);
  }
  state.feedEpisodes[feed.feed_url] = episodes;
  persist(KEYS.feeds, state.feeds);
  persist(KEYS.feedEpisodes, state.feedEpisodes);
  notify();
}

/** 退訂：移除 feed + feedEpisodes[feedUrl]。captures / episodeIndex / srs 一律保留（不級聯）。 */
export function removeFeed(feedUrl: string): void {
  state.feeds = state.feeds.filter((f) => f.feed_url !== feedUrl);
  delete state.feedEpisodes[feedUrl];
  persist(KEYS.feeds, state.feeds);
  persist(KEYS.feedEpisodes, state.feedEpisodes);
  notify();
}

/** refresh 用：整組替換 + 更新該 feed 的 last_fetched_at。 */
export function setFeedEpisodes(feedUrl: string, episodes: Episode[]): void {
  state.feedEpisodes[feedUrl] = episodes;
  const idx = state.feeds.findIndex((f) => f.feed_url === feedUrl);
  if (idx >= 0) {
    state.feeds[idx] = {
      ...state.feeds[idx],
      last_fetched_at: new Date().toISOString(),
    };
    persist(KEYS.feeds, state.feeds);
  }
  persist(KEYS.feedEpisodes, state.feedEpisodes);
  notify();
}

export function getFeedEpisodes(feedUrl: string): Episode[] {
  return state.feedEpisodes[feedUrl] ?? [];
}

/** 播放選集時呼叫：快照進 episodeIndex + best-effort 同步 Supabase episodes 列。 */
export function rememberEpisode(episode: Episode): void {
  state.episodeIndex[episode.id] = episode;
  persist(KEYS.episodeIndex, state.episodeIndex);
  void syncEpisode(episode);
  notify();
}

/** 查找順序：episodeIndex → 所有 feedEpisodes → DEMO_EPISODES。 */
export function findEpisodeById(id: string): Episode | undefined {
  const indexed = state.episodeIndex[id];
  if (indexed) return indexed;
  for (const eps of Object.values(state.feedEpisodes)) {
    const hit = eps.find((e) => e.id === id);
    if (hit) return hit;
  }
  return DEMO_EPISODES.find((e) => e.id === id);
}

// ---------------------------------------------------------------------------
// Practice records
// ---------------------------------------------------------------------------

export function getPracticeLog(): PracticeRecord[] {
  return state.practiceLog;
}

export function addPracticeRecord(record: PracticeRecord): void {
  state.practiceLog.unshift(record);
  persist(KEYS.practice, state.practiceLog);
  void syncPracticeRecord(record);
  notify();
}

// ---------------------------------------------------------------------------
// Best-effort Supabase sync (fire-and-forget; no-ops without env vars)
// ---------------------------------------------------------------------------

async function syncCapture(capture: Capture): Promise<void> {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('captures').upsert(
      {
        id: capture.id,
        episode_id: capture.episode_id,
        window_start: capture.window_start,
        window_end: capture.window_end,
        context_start: capture.context_start,
        context_end: capture.context_end,
        strength: capture.strength,
        status: capture.status,
        transcript_text: capture.transcript_text ?? null,
        diagnosis: capture.diagnosis ?? null,
        created_at: capture.created_at,
      },
      { onConflict: 'id' },
    );
    if (error) console.warn('[store] capture sync failed:', error.message);
  } catch (err) {
    console.warn('[store] capture sync error:', err);
  }
}

async function syncSrsItem(item: SrsItem): Promise<void> {
  if (!supabase) return;
  try {
    const capture = getCapture(item.capture_id);
    const { error } = await supabase.from('difficulty_items').upsert(
      {
        capture_id: item.capture_id,
        type: capture?.diagnosis?.type ?? null,
        ease: item.ease,
        interval_days: item.interval_days,
        due_date: item.due_date,
        reps: item.reps,
      },
      { onConflict: 'capture_id' },
    );
    if (error) console.warn('[store] srs sync failed:', error.message);
  } catch (err) {
    console.warn('[store] srs sync error:', err);
  }
}

/**
 * replay_events / captures 的 FK 需要 episodes 列先存在；rememberEpisode 在
 * 選集當下就 upsert（第一次 rewind 前通常已完成）。
 */
async function syncEpisode(ep: Episode): Promise<void> {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('episodes').upsert(
      {
        id: ep.id,
        podcast_title: ep.podcast,
        title: ep.title,
        audio_url: ep.audioUrl,
        duration_sec: ep.durationSec > 0 ? Math.round(ep.durationSec) : null,
        rss_guid: ep.guid ?? null,
        published_at: ep.pubDate ?? null,
        feed_url: ep.feedUrl ?? null,
        transcript_url: ep.transcriptUrl ?? null,
        transcript_type: ep.transcriptType ?? null,
      },
      { onConflict: 'id' },
    );
    if (error) console.warn('[store] episode sync failed:', error.message);
  } catch (err) {
    console.warn('[store] episode sync error:', err);
  }
}

async function syncPracticeRecord(record: PracticeRecord): Promise<void> {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('practice_sessions').insert({
      session_date: record.date,
      items_total: record.items_total,
      items_completed: record.items_completed,
      completion_rate:
        record.items_total > 0
          ? record.items_completed / record.items_total
          : null,
      created_at: record.created_at,
    });
    if (error) console.warn('[store] practice sync failed:', error.message);
  } catch (err) {
    console.warn('[store] practice sync error:', err);
  }
}
