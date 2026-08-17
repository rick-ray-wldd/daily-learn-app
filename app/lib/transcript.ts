/**
 * Transcripts — RSS 官方逐字稿優先，Whisper 窗口化為 fallback（ADR-0005）。
 *
 * 兩種來源、兩種形狀：
 *
 *   RSS `podcast:transcript`  → 一次拿到整集，免費，**所有窗口立刻標記為已覆蓋**
 *   Whisper（Edge Function）  → 一次只轉一個 10 分鐘窗口，逐段累積
 *
 * 為什麼窗口化：ADR-0005 早就規定只轉錄「學習者實際在聽的鄰近範圍」，但從未
 * 實作。整集送 Whisper 有兩個硬傷——25MB 上限（135MB 的 2.5 小時單集直接出局），
 * 以及沒人在聽的部分也要付錢。伺服器端改用 HTTP Range 取位元組切片後，10 分鐘
 * 窗口約 9MB / $0.06，而且實測起點偏差 0.0 秒。
 *
 * 窗口對齊到固定邊界（`floor(t / WINDOW_SEC)`），所以覆蓋範圍只是一個索引集合，
 * 不需要區間合併邏輯，重複請求也自然被去重。
 *
 * 預抓：`ensureWindowFor(t)` 會把 t 所在的窗口與**下一個**窗口一起排進來。
 * 伺服器端一個 10 分鐘窗口要 45–60 秒，等使用者滑到才要就一定來不及。
 */
import * as FileSystem from 'expo-file-system/legacy';

import { Episode } from './episodes';
import { fetchWithTimeout } from './rss';
import { getTranscriptMeta, setTranscriptMeta } from './store';
import { ensureSession, supabase } from './supabase';
import { parseSrt, parseVtt } from './transcriptFormats';
import { TranscriptSegment } from './types';
import { t } from './i18n';

/** 與 Edge Function 的 MAX_WINDOW_SEC 一致；改一邊就要改另一邊。 */
const WINDOW_SEC = 600;
/** 播放位置距離已覆蓋範圍的尾端小於這個秒數就預抓下一段。 */
const PREFETCH_LEAD_SEC = 150;

export type TranscriptResult =
  | { status: 'ready'; segments: TranscriptSegment[] }
  | { status: 'failed'; reason: string };

export interface WindowSentences {
  /** One segment of leading context (previous sentence), if any. */
  before?: TranscriptSegment;
  /** Segments overlapping the requested window. */
  inWindow: TranscriptSegment[];
  /** One segment of trailing context (next sentence), if any. */
  after?: TranscriptSegment;
}

/** 一集的逐字稿狀態：已知句子 + 哪些窗口轉過了。 */
interface EpisodeTranscript {
  /** Sorted by `start`, deduped. */
  segments: TranscriptSegment[];
  /** Window indices already transcribed (RSS 來源 = 全部)。 */
  windows: Set<number>;
  /** Window index → 失敗原因（不重試，避免重複扣配額）。 */
  failedWindows: Map<number, string>;
  /** True when an RSS transcript covered the whole episode. */
  complete: boolean;
}

const cache = new Map<string, EpisodeTranscript>();
const inFlight = new Map<string, Promise<TranscriptResult>>();

const windowIndexOf = (t: number) => Math.max(0, Math.floor(t / WINDOW_SEC));

function stateFor(episodeId: string): EpisodeTranscript {
  let s = cache.get(episodeId);
  if (!s) {
    s = { segments: [], windows: new Set(), failedWindows: new Map(), complete: false };
    cache.set(episodeId, s);
  }
  return s;
}

/** Whisper 走 Edge Function，所以「能不能轉錄」＝ Supabase 有沒有設定好。 */
export function isTranscriptionConfigured(): boolean {
  return supabase !== null;
}

/** 有 Whisper 後端或該集自帶 RSS 逐字稿即可轉錄。 */
export function canTranscribe(episode: Episode): boolean {
  return isTranscriptionConfigured() || Boolean(episode.transcriptUrl);
}

/** 目前已知的句子（永遠依 start 排序）。UI 直接讀這個。 */
export function getSegments(episodeId: string): TranscriptSegment[] {
  return cache.get(episodeId)?.segments ?? [];
}

/** 這個時間點的逐字稿在手上了嗎？ */
export function isCovered(episodeId: string, t: number): boolean {
  const s = cache.get(episodeId);
  if (!s) return false;
  return s.complete || s.windows.has(windowIndexOf(t));
}

/** 該時間點的窗口曾經轉錄失敗過的話，回傳原因（UI 用來顯示為什麼沒有稿）。 */
export function windowFailure(episodeId: string, t: number): string | undefined {
  return cache.get(episodeId)?.failedWindows.get(windowIndexOf(t));
}

/** 已覆蓋範圍的尾端（秒）；沒有任何覆蓋時回 null。 */
export function coveredUntil(episodeId: string, t: number): number | null {
  const s = cache.get(episodeId);
  if (!s) return null;
  if (s.complete) return Number.POSITIVE_INFINITY;
  let idx = windowIndexOf(t);
  if (!s.windows.has(idx)) return null;
  while (s.windows.has(idx + 1)) idx += 1;
  return (idx + 1) * WINDOW_SEC;
}

/**
 * 確保 `positionSec` 附近的逐字稿存在，並在接近尾端時預抓下一段。
 *
 * 呼叫端可以每秒呼叫——重複請求會被 in-flight map 與 window 集合擋掉，
 * 不會重複扣配額。
 */
export async function ensureWindowFor(
  episode: Episode,
  positionSec: number,
): Promise<TranscriptResult | null> {
  if (!canTranscribe(episode)) return null;

  const s = stateFor(episode.id);

  // RSS 逐字稿一次覆蓋整集，先試它——免費而且沒有窗口概念。
  if (!s.complete && s.segments.length === 0 && episode.transcriptUrl) {
    const rss = await ensureRssTranscript(episode);
    if (rss) return rss;
  }
  if (s.complete) return { status: 'ready', segments: s.segments };

  const current = windowIndexOf(positionSec);
  const target = pickWindow(s, current, positionSec);
  if (target === null) return { status: 'ready', segments: s.segments };

  const key = `${episode.id}#${target}`;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = fetchWindow(episode, target).finally(() => inFlight.delete(key));
  inFlight.set(key, task);
  return task;
}

/**
 * 下一個該抓的窗口：目前這個還沒有就抓它；有了但快播到尾端就抓下一個。
 * 都齊了回 null。
 */
function pickWindow(
  s: EpisodeTranscript,
  current: number,
  positionSec: number,
): number | null {
  if (!s.windows.has(current) && !s.failedWindows.has(current)) return current;

  const edge = (current + 1) * WINDOW_SEC;
  const next = current + 1;
  if (
    edge - positionSec <= PREFETCH_LEAD_SEC &&
    !s.windows.has(next) &&
    !s.failedWindows.has(next)
  ) {
    return next;
  }
  return null;
}

async function fetchWindow(
  episode: Episode,
  windowIdx: number,
): Promise<TranscriptResult> {
  const s = stateFor(episode.id);
  const start = windowIdx * WINDOW_SEC;
  const end = Math.min(
    episode.durationSec || start + WINDOW_SEC,
    start + WINDOW_SEC,
  );

  if (!supabase) return failWindow(episode.id, windowIdx, t('tx.no_supabase'));
  if (end <= start) {
    return failWindow(episode.id, windowIdx, t('tx.out_of_range'));
  }

  try {
    const userId = await ensureSession();
    if (!userId) return failWindow(episode.id, windowIdx, t('tx.no_session'));

    const { data, error } = await supabase.functions.invoke('transcribe', {
      body: {
        episodeId: episode.id,
        audioUrl: episode.audioUrl,
        durationSec: episode.durationSec,
        windowStart: start,
        windowEnd: end,
      },
    });

    if (error) {
      return failWindow(episode.id, windowIdx, t('tx.service_failed', { msg: error.message }));
    }

    const result = data as
      | { status: 'ready'; segments: TranscriptSegment[] }
      | { status: 'failed'; reason: string }
      | null;

    if (!result || result.status !== 'ready' || !result.segments?.length) {
      return failWindow(
        episode.id,
        windowIdx,
        result?.status === 'failed' ? result.reason : t('tx.unexpected'),
      );
    }

    mergeSegments(s, result.segments);
    s.windows.add(windowIdx);
    await persist(episode.id, s);
    return { status: 'ready', segments: s.segments };
  } catch (err) {
    return failWindow(episode.id, windowIdx, t('tx.failed', { msg: String(err) }));
  }
}

/** 併入新句子並保持依 start 排序、去重（窗口邊界會有重疊句）。 */
function mergeSegments(s: EpisodeTranscript, incoming: TranscriptSegment[]) {
  const byStart = new Map<number, TranscriptSegment>();
  for (const seg of s.segments) byStart.set(Math.round(seg.start * 10), seg);
  for (const seg of incoming) byStart.set(Math.round(seg.start * 10), seg);
  s.segments = [...byStart.values()].sort((a, b) => a.start - b.start);
}

async function ensureRssTranscript(
  episode: Episode,
): Promise<TranscriptResult | null> {
  const segs = await fetchRssTranscript(episode);
  if (!segs || segs.length === 0) return null;
  const s = stateFor(episode.id);
  mergeSegments(s, segs);
  s.complete = true; // 整集都有了，之後不再呼叫 Whisper
  await persist(episode.id, s);
  return { status: 'ready', segments: s.segments };
}

/** 下載 + 解析 podcast:transcript。任何失敗回 null（console.warn），不 throw。 */
async function fetchRssTranscript(
  episode: Episode,
): Promise<TranscriptSegment[] | null> {
  if (!episode.transcriptUrl || !episode.transcriptType) return null;
  try {
    const res = await fetchWithTimeout(episode.transcriptUrl, 20_000);
    if (!res.ok) {
      console.warn(
        `[transcript] RSS transcript HTTP ${res.status}: ${episode.transcriptUrl}`,
      );
      return null;
    }
    const raw = await res.text();
    const segs =
      episode.transcriptType === 'srt' ? parseSrt(raw) : parseVtt(raw);
    return segs.length > 0 ? segs : null;
  } catch (err) {
    console.warn('[transcript] RSS transcript fetch failed:', err);
    return null;
  }
}

function failWindow(
  episodeId: string,
  windowIdx: number,
  reason: string,
): TranscriptResult {
  console.warn(`[transcript] ${episodeId} w${windowIdx}: ${reason}`);
  // 記在該窗口上，不是整集 —— 一個窗口失敗不該讓其他窗口也放棄。
  stateFor(episodeId).failedWindows.set(windowIdx, reason);
  setTranscriptMeta({
    episode_id: episodeId,
    status: 'failed',
    error: reason,
    updated_at: new Date().toISOString(),
  });
  return { status: 'failed', reason };
}

// ---------------------------------------------------------------------------
// Disk cache（跨重啟）。存 segments + 已覆蓋窗口，讓下次開啟不用重付錢。
// ---------------------------------------------------------------------------

interface DiskShape {
  segments: TranscriptSegment[];
  windows: number[];
  complete: boolean;
}

function transcriptDir(): string {
  return `${FileSystem.cacheDirectory}echo-transcripts/`;
}

function transcriptPath(episodeId: string): string {
  return `${transcriptDir()}${episodeId}.json`;
}

async function persist(episodeId: string, s: EpisodeTranscript): Promise<void> {
  try {
    await FileSystem.makeDirectoryAsync(transcriptDir(), {
      intermediates: true,
    }).catch(() => undefined);
    const payload: DiskShape = {
      segments: s.segments,
      windows: [...s.windows],
      complete: s.complete,
    };
    await FileSystem.writeAsStringAsync(
      transcriptPath(episodeId),
      JSON.stringify(payload),
    );
    setTranscriptMeta({
      episode_id: episodeId,
      status: 'done',
      path: transcriptPath(episodeId),
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    // 快取寫入失敗不該讓已經拿到的逐字稿消失——只是下次要重轉。
    console.warn(`[transcript] ${episodeId}: cache write failed`, err);
  }
}

/** Re-hydrate from disk（app 啟動 / 換集時呼叫）。 */
export async function preloadTranscript(episodeId: string): Promise<boolean> {
  if (cache.has(episodeId)) return true;
  try {
    const path = transcriptPath(episodeId);
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return false;
    const parsed: unknown = JSON.parse(await FileSystem.readAsStringAsync(path));

    // 舊版格式是一個純 segments 陣列；當成「有句子但沒有窗口資訊」讀進來，
    // 讓它照樣顯示，缺的窗口之後補轉即可。
    if (Array.isArray(parsed)) {
      cache.set(episodeId, {
        segments: parsed as TranscriptSegment[],
        windows: new Set(),
        failedWindows: new Map(),
        complete: false,
      });
      return true;
    }

    const d = parsed as DiskShape;
    if (!d || !Array.isArray(d.segments)) {
      await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => {});
      return false;
    }
    cache.set(episodeId, {
      segments: d.segments,
      windows: new Set(d.windows ?? []),
      failedWindows: new Map(),
      complete: Boolean(d.complete),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 練習頁用：確保某個 capture 窗口的逐字稿存在（不管播放位置在哪）。
 * 保留舊名字，因為 Practice.tsx 依賴它。
 */
export async function ensureTranscript(
  episode: Episode,
  aroundSec?: number,
): Promise<TranscriptResult | null> {
  return ensureWindowFor(episode, aroundSec ?? 0);
}

/**
 * Segments overlapping [start, end], plus one segment of context on each
 * side (signal-design.md §4: 永遠多存前後各 1 句). Returns null when the
 * episode has no transcript loaded yet — call ensureWindowFor first.
 */
export function sentencesInWindow(
  episodeId: string,
  start: number,
  end: number,
): WindowSentences | null {
  const segments = getSegments(episodeId);
  if (segments.length === 0) return null;

  const first = segments.findIndex((s) => s.end > start && s.start < end);
  if (first < 0) return { inWindow: [] };
  let last = first;
  while (
    last + 1 < segments.length &&
    segments[last + 1].start < end &&
    segments[last + 1].end > start
  ) {
    last += 1;
  }
  return {
    before: first > 0 ? segments[first - 1] : undefined,
    inWindow: segments.slice(first, last + 1),
    after: last + 1 < segments.length ? segments[last + 1] : undefined,
  };
}
