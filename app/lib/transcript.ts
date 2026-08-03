/**
 * Transcripts — RSS 官方逐字稿優先，Whisper 為 fallback。
 *
 * 路徑選擇（transcribe()）：
 *   1. disk cache（永久，跨重啟）
 *   2. episode.transcriptUrl（podcast:transcript srt/vtt）→ 免 key 免成本，
 *      整段都在 client 做，不需要 server
 *   3. Whisper → 交給 `transcribe` Edge Function（ADR-0008）：client 只送
 *      audioUrl，**由 server 下載 mp3 並轉給 Whisper**，回傳 segments 後
 *      存進 disk cache 並在 store 記一個 pointer，同一集不會轉錄兩次。
 *
 * 為什麼把音檔留在 server 側：手機不必再用行動網路上傳 20MB+；而且 client
 * 沒有 ffmpeg（見下方 25MB 註記），未來要切檔只需改 server，不用發新版 app。
 *
 * Cost note: Whisper is ~$0.006 / audio minute → a 25-minute episode is
 * about $0.15。25MB 是 OpenAI 硬上限，server 端會擋，client 端先用 RSS 宣告的
 * enclosure 大小快篩，省掉一次來回。
 */
import * as FileSystem from 'expo-file-system/legacy';

import { Episode } from './episodes';
import { fetchWithTimeout } from './rss';
import { getTranscriptMeta, setTranscriptMeta } from './store';
import { ensureSession, supabase } from './supabase';
import { parseSrt, parseVtt } from './transcriptFormats';
import { TranscriptSegment } from './types';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // Whisper hard limit

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

/** Whisper 走 Edge Function，所以「能不能轉錄」＝ Supabase 有沒有設定好。 */
export function isTranscriptionConfigured(): boolean {
  return supabase !== null;
}

/** 有 Whisper 後端或該集自帶 RSS 逐字稿即可轉錄。 */
export function canTranscribe(episode: Episode): boolean {
  return isTranscriptionConfigured() || Boolean(episode.transcriptUrl);
}

const memoryCache = new Map<string, TranscriptSegment[]>();
const inFlight = new Map<string, Promise<TranscriptResult>>();
/** Session-level failure memo so a >25MB episode isn't re-downloaded per card. */
const failedThisSession = new Map<string, string>();

function transcriptDir(): string {
  return `${FileSystem.cacheDirectory}echo-transcripts/`;
}

function transcriptPath(episodeId: string): string {
  return `${transcriptDir()}${episodeId}.json`;
}

/**
 * Ensure a transcript exists for the episode.
 * Returns null when neither the Whisper backend nor an RSS transcript is
 * available (UI shows 「逐字稿待轉錄」).
 * Never throws — failures come back as { status: 'failed', reason }.
 */
export async function ensureTranscript(
  episode: Episode,
): Promise<TranscriptResult | null> {
  if (!canTranscribe(episode)) return null;

  const cached = memoryCache.get(episode.id);
  if (cached) return { status: 'ready', segments: cached };

  const sessionFailure = failedThisSession.get(episode.id);
  if (sessionFailure) return { status: 'failed', reason: sessionFailure };

  const pending = inFlight.get(episode.id);
  if (pending) return pending;

  const task = transcribe(episode).finally(() => inFlight.delete(episode.id));
  inFlight.set(episode.id, task);
  return task;
}

async function transcribe(episode: Episode): Promise<TranscriptResult> {
  try {
    // 1. Disk cache hit? (survives app restarts)
    //    損壞的快取（JSON 壞掉或不是陣列）不能記成永久 fail —— 刪掉壞檔後
    //    照常 fall through 走 RSS/Whisper 流程。
    const jsonInfo = await FileSystem.getInfoAsync(transcriptPath(episode.id));
    if (jsonInfo.exists) {
      try {
        const raw = await FileSystem.readAsStringAsync(
          transcriptPath(episode.id),
        );
        const segments = JSON.parse(raw) as TranscriptSegment[];
        if (!Array.isArray(segments)) {
          throw new Error('disk cache is not a segments array');
        }
        memoryCache.set(episode.id, segments);
        return { status: 'ready', segments };
      } catch (cacheErr) {
        console.warn(
          `[transcript] ${episode.id}: corrupt disk cache, deleting`,
          cacheErr,
        );
        await FileSystem.deleteAsync(transcriptPath(episode.id), {
          idempotent: true,
        }).catch(() => undefined);
      }
    }

    await FileSystem.makeDirectoryAsync(transcriptDir(), {
      intermediates: true,
    }).catch(() => undefined); // exists already → fine

    // 2. RSS 官方逐字稿（免 key 免成本）。失敗時：有 key → fall through 走
    //    Whisper；無 key → failed 卡片顯示原因。
    if (episode.transcriptUrl && episode.transcriptType) {
      const segs = await fetchRssTranscript(episode);
      if (segs && segs.length > 0) {
        await FileSystem.writeAsStringAsync(
          transcriptPath(episode.id),
          JSON.stringify(segs),
        );
        memoryCache.set(episode.id, segs);
        setTranscriptMeta({
          episode_id: episode.id,
          status: 'done',
          path: transcriptPath(episode.id),
          updated_at: new Date().toISOString(),
        });
        return { status: 'ready', segments: segs };
      }
      if (!isTranscriptionConfigured()) {
        return fail(
          episode.id,
          '官方逐字稿下載/解析失敗，且未設定 Supabase 無法改用 Whisper',
        );
      }
      // 有後端 → fall through 走 Whisper 流程
    }

    // 3. Whisper 前快篩：enclosure length 超過 25MB 直接放棄，省掉一次來回
    //    （length 可能缺或亂寫，server 端下載後仍有實際大小檢查）。
    if (episode.enclosureBytes && episode.enclosureBytes > MAX_UPLOAD_BYTES) {
      const mb = (episode.enclosureBytes / (1024 * 1024)).toFixed(1);
      return fail(
        episode.id,
        `音檔 ${mb}MB 超過 Whisper 25MB 上限（此集太長暫不支援轉錄）`,
      );
    }

    // 4. 交給 Edge Function：只送 audioUrl，mp3 由 server 下載並轉給 Whisper
    //    （ADR-0008 — provider key 不再進 client bundle）。
    if (!supabase) return fail(episode.id, '未設定 Supabase，無法轉錄');

    const userId = await ensureSession();
    if (!userId) return fail(episode.id, '尚未建立 session，無法轉錄');

    const { data, error } = await supabase.functions.invoke('transcribe', {
      body: { episodeId: episode.id, audioUrl: episode.audioUrl },
    });

    if (error) {
      return fail(episode.id, `轉錄服務失敗：${error.message}`);
    }

    const result = data as
      | { status: 'ready'; segments: TranscriptSegment[] }
      | { status: 'failed'; reason: string }
      | null;

    if (!result || result.status !== 'ready') {
      return fail(episode.id, result?.reason ?? '轉錄服務回傳非預期結果');
    }

    const segments: TranscriptSegment[] = result.segments ?? [];
    if (segments.length === 0) {
      return fail(episode.id, 'Whisper 回傳空的 segments');
    }

    // 5. Cache the result.
    await FileSystem.writeAsStringAsync(
      transcriptPath(episode.id),
      JSON.stringify(segments),
    );

    memoryCache.set(episode.id, segments);
    setTranscriptMeta({
      episode_id: episode.id,
      status: 'done',
      path: transcriptPath(episode.id),
      updated_at: new Date().toISOString(),
    });
    return { status: 'ready', segments };
  } catch (err) {
    return fail(episode.id, `轉錄失敗：${String(err)}`);
  }
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

function fail(episodeId: string, reason: string): TranscriptResult {
  console.warn(`[transcript] ${episodeId}: ${reason}`);
  failedThisSession.set(episodeId, reason);
  setTranscriptMeta({
    episode_id: episodeId,
    status: 'failed',
    error: reason,
    updated_at: new Date().toISOString(),
  });
  return { status: 'failed', reason };
}

/**
 * Segments overlapping [start, end], plus one segment of context on each
 * side (signal-design.md §4: 永遠多存前後各 1 句). Returns null when the
 * episode has no transcript loaded yet — call ensureTranscript first.
 */
export function sentencesInWindow(
  episodeId: string,
  start: number,
  end: number,
): WindowSentences | null {
  const segments = memoryCache.get(episodeId);
  if (!segments || segments.length === 0) return null;

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

/** Re-hydrate the memory cache from a disk transcript (used on app start). */
export async function preloadTranscript(episodeId: string): Promise<boolean> {
  if (memoryCache.has(episodeId)) return true;
  const meta = getTranscriptMeta(episodeId);
  if (meta?.status !== 'done' || !meta.path) return false;
  try {
    const info = await FileSystem.getInfoAsync(meta.path);
    if (!info.exists) return false;
    const raw = await FileSystem.readAsStringAsync(meta.path);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      // Corrupt-but-valid-JSON cache: drop it so the normal RSS/Whisper
      // flow rebuilds it (mirrors the guard in transcribe(), m12).
      await FileSystem.deleteAsync(meta.path, { idempotent: true }).catch(() => {});
      return false;
    }
    memoryCache.set(episodeId, parsed as TranscriptSegment[]);
    return true;
  } catch {
    return false;
  }
}
