/**
 * transcribe — Whisper ASR, windowed, server side (ADR-0005 + ADR-0008).
 *
 *   in : { episodeId, audioUrl, windowStart?, windowEnd?, durationSec? }
 *   out: { status: 'ready', segments, coverage: { start, end } }
 *      | { status: 'failed', reason }
 *
 * Why windowed: ADR-0005 specifies transcribing only the neighbourhood of what
 * the learner is actually listening to, not whole episodes. That was never
 * implemented — the client sent entire files — which made the feature both
 * expensive (~$0.89 for a 148-minute episode) and, past ~25 minutes, simply
 * impossible: Whisper rejects anything over 25MB.
 *
 * How the slice is taken: Edge Functions run on Deno and cannot run ffmpeg
 * (ADR-0006), so we cannot decode-and-cut. Instead we ask the origin for a byte
 * range and hand Whisper the raw mp3 frames inside it. MP3 is frame-based, so a
 * byte slice is decodable on its own; what a slice loses is the file header,
 * which Whisper does not need to transcribe.
 *
 * ⚠️ The byte↔time mapping assumes a constant bitrate. For CBR files (the large
 * majority of podcast enclosures) it is exact. For VBR it drifts, roughly in
 * proportion to how far into the file the window sits. PAD_SEC absorbs small
 * drift at the edges; the caller gets `coverage` back and should trust that over
 * what it asked for.
 */
import { consumeQuota, resolveCaller } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? '';
const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** Whisper hard limit. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/**
 * Longest window we will transcribe in one call. Bounds both the request time
 * and the per-call cost (~$0.06 at $0.006/audio-minute).
 */
const MAX_WINDOW_SEC = 600;
/** Slice edges are approximate; overshoot then trim what we return. */
const PAD_SEC = 5;
/** Give up on a slow origin before the platform kills the whole request. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/**
 * Per-user daily cap, counted in *calls*. At MAX_WINDOW_SEC each, 24 calls is
 * four hours of audio ≈ $1.44/day/user worst case — generous next to a realistic
 * session (a 45-minute commute is 5 windows) but still a hard ceiling.
 */
const DAILY_LIMIT = 24;

interface TranscriptSegment {
  id: number;
  start: number; // seconds, episode-relative
  end: number;
  text: string;
}

function failed(reason: string): Response {
  console.warn(`[transcribe] ${reason}`);
  return json({ status: 'failed', reason });
}

/** Bytes-per-second of audio, from the enclosure's own size and duration. */
function bytesPerSecond(totalBytes: number, durationSec: number): number {
  return totalBytes / durationSec;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const caller = await resolveCaller(req);
  if (!caller) return json({ error: 'authentication required' }, 401);

  let body: {
    episodeId?: unknown;
    audioUrl?: unknown;
    windowStart?: unknown;
    windowEnd?: unknown;
    durationSec?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const episodeId =
    typeof body.episodeId === 'string' ? body.episodeId.trim() : '';
  const audioUrl = typeof body.audioUrl === 'string' ? body.audioUrl.trim() : '';
  if (!episodeId || !audioUrl) {
    return json({ error: 'episodeId and audioUrl are required' }, 400);
  }

  // Only fetch what the app is meant to fetch — this function must not become
  // an open proxy that will retrieve any URL on the caller's behalf.
  let parsed: URL;
  try {
    parsed = new URL(audioUrl);
  } catch {
    return json({ error: 'audioUrl is not a valid URL' }, 400);
  }
  if (parsed.protocol !== 'https:') {
    return json({ error: 'audioUrl must be https' }, 400);
  }

  const durationSec = Number(body.durationSec);
  const rawStart = Number(body.windowStart);
  const rawEnd = Number(body.windowEnd);
  const windowed =
    Number.isFinite(rawStart) &&
    Number.isFinite(rawEnd) &&
    Number.isFinite(durationSec) &&
    durationSec > 0 &&
    rawEnd > rawStart;

  let wantStart = 0;
  let wantEnd = 0;
  if (windowed) {
    wantStart = Math.max(0, rawStart);
    wantEnd = Math.min(durationSec, Math.min(rawEnd, wantStart + MAX_WINDOW_SEC));
    if (wantEnd <= wantStart) {
      return json({ error: 'window is empty after clamping' }, 400);
    }
  }

  // Charge quota only once the request is well-formed.
  const quota = await consumeQuota(caller.userId, 'transcribe', DAILY_LIMIT);
  if (!quota.ok) {
    return json(
      { error: 'daily transcription limit reached', used: quota.used },
      429,
    );
  }

  // What we actually ask the origin for — padded, then trimmed on the way out.
  const fetchStart = windowed ? Math.max(0, wantStart - PAD_SEC) : 0;
  const fetchEnd = windowed
    ? Math.min(durationSec, wantEnd + PAD_SEC)
    : 0;

  let audio: ArrayBuffer;
  let sliceOffsetSec = 0; // episode-time of the first byte we sent to Whisper

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {};
      let expectedBytes = 0;

      if (windowed) {
        // Ask for size first so the byte↔time mapping has a denominator.
        const head = await fetch(parsed, {
          method: 'HEAD',
          signal: controller.signal,
        });
        if (!head.ok) return failed(`音檔 HEAD 失敗（HTTP ${head.status}）`);

        const totalBytes = Number(head.headers.get('content-length'));
        const acceptsRanges = (head.headers.get('accept-ranges') ?? '')
          .toLowerCase()
          .includes('bytes');

        if (Number.isFinite(totalBytes) && totalBytes > 0 && acceptsRanges) {
          const bps = bytesPerSecond(totalBytes, durationSec);
          const byteStart = Math.max(0, Math.floor(fetchStart * bps));
          const byteEnd = Math.min(
            totalBytes - 1,
            Math.ceil(fetchEnd * bps),
          );
          expectedBytes = byteEnd - byteStart + 1;
          if (expectedBytes > MAX_UPLOAD_BYTES) {
            return failed(
              `窗口 ${Math.round((fetchEnd - fetchStart) / 60)} 分鐘換算 ${(
                expectedBytes /
                (1024 * 1024)
              ).toFixed(1)}MB，超過 Whisper 25MB 上限`,
            );
          }
          headers.Range = `bytes=${byteStart}-${byteEnd}`;
          sliceOffsetSec = byteStart / bps;
        } else {
          // Origin won't serve ranges. Fall back to the whole file, which only
          // works for short episodes — report honestly rather than silently
          // transcribing (and charging for) the wrong thing.
          if (!Number.isFinite(totalBytes) || totalBytes > MAX_UPLOAD_BYTES) {
            return failed(
              '音檔來源不支援 Range 請求，且整集超過 25MB — 此集無法轉錄',
            );
          }
          sliceOffsetSec = 0;
        }
      }

      const res = await fetch(parsed, {
        headers,
        signal: controller.signal,
      });
      // 206 = the range we asked for; 200 = origin ignored Range and sent all.
      if (!res.ok) return failed(`音檔下載失敗（HTTP ${res.status}）`);
      if (headers.Range && res.status === 200) {
        sliceOffsetSec = 0; // origin ignored the range; timestamps are absolute
      }

      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
        const mb = (declared / (1024 * 1024)).toFixed(1);
        return failed(`音檔 ${mb}MB 超過 Whisper 25MB 上限`);
      }

      audio = await res.arrayBuffer();
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const aborted = err instanceof DOMException && err.name === 'AbortError';
    return failed(aborted ? '音檔下載逾時' : `音檔下載失敗：${String(err)}`);
  }

  if (audio.byteLength > MAX_UPLOAD_BYTES) {
    const mb = (audio.byteLength / (1024 * 1024)).toFixed(1);
    return failed(`音檔 ${mb}MB 超過 Whisper 25MB 上限`);
  }

  try {
    const form = new FormData();
    form.append(
      'file',
      new Blob([audio], { type: 'audio/mpeg' }),
      `${episodeId}.mp3`,
    );
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');

    const res = await fetch(WHISPER_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return failed(`Whisper 回應 ${res.status}: ${text.slice(0, 200)}`);
    }

    const parsedBody = (await res.json()) as {
      segments?: { id: number; start: number; end: number; text: string }[];
    };

    // Whisper times the slice from 0; shift into episode time.
    const shifted: TranscriptSegment[] = (parsedBody.segments ?? []).map((s) => ({
      id: s.id,
      start: s.start + sliceOffsetSec,
      end: s.end + sliceOffsetSec,
      text: s.text.trim(),
    }));

    // Drop the padding we added, but keep any segment that overlaps the window
    // rather than requiring containment — a sentence straddling the edge is
    // exactly the one the learner is listening to.
    const segments = windowed
      ? shifted.filter((s) => s.end > wantStart && s.start < wantEnd)
      : shifted;

    if (segments.length === 0) {
      return failed('Whisper 回傳空的 segments');
    }

    return json({
      status: 'ready',
      segments,
      coverage: {
        start: segments[0].start,
        end: segments[segments.length - 1].end,
      },
    });
  } catch (err) {
    return failed(`轉錄失敗：${String(err)}`);
  }
});
