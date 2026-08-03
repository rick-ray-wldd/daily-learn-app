/**
 * transcribe — Whisper ASR, server side (ADR-0008).
 *
 *   in : { episodeId: string, audioUrl: string }
 *   out: { status: 'ready', segments: TranscriptSegment[] }
 *      | { status: 'failed', reason: string }
 *
 * The client sends the **audio URL**, not the audio. The function downloads the
 * mp3 here and forwards it to Whisper, which is a deliberate change from the
 * old client-side path (`FileSystem.uploadAsync` of a downloaded mp3):
 *
 *   - the phone no longer pushes ~20MB up over cellular, only a short JSON body;
 *   - the 25MB cap is checked against the real body on a fast connection;
 *   - splitting oversized episodes becomes possible later without an app update
 *     (there is no ffmpeg on the client — see the note in transcript.ts).
 *
 * The RSS official-transcript path stays entirely on the client: it needs no key
 * and no server round trip.
 *
 * Wall-clock: download + Whisper for a 25-minute episode is usually well under
 * the Edge Function limit, but a slow origin can blow it — the download has its
 * own timeout so we fail with a reason rather than being killed mid-request.
 */
import { consumeQuota, resolveCaller } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';

const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? '';
const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** Whisper hard limit. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Give up on a slow origin before the platform kills the whole request. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/**
 * Per-user daily cap. Whisper is ~$0.006/audio-minute, so a 25-minute episode
 * costs ~$0.15 — this is the line item that can actually run up a bill.
 */
const DAILY_LIMIT = 10;

interface TranscriptSegment {
  id: number;
  start: number;
  end: number;
  text: string;
}

function failed(reason: string): Response {
  console.warn(`[transcribe] ${reason}`);
  return json({ status: 'failed', reason });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const caller = await resolveCaller(req);
  if (!caller) return json({ error: 'authentication required' }, 401);

  let body: { episodeId?: unknown; audioUrl?: unknown };
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

  // Charge quota only once the request is well-formed.
  const quota = await consumeQuota(caller.userId, 'transcribe', DAILY_LIMIT);
  if (!quota.ok) {
    return json(
      { error: 'daily transcription limit reached', used: quota.used },
      429,
    );
  }

  let audio: ArrayBuffer;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(parsed, { signal: controller.signal });
      if (!res.ok) {
        return failed(`音檔下載失敗（HTTP ${res.status}）`);
      }

      // Trust content-length only as a fast reject; the real check is below.
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
        const mb = (declared / (1024 * 1024)).toFixed(1);
        return failed(`音檔 ${mb}MB 超過 Whisper 25MB 上限（此集太長暫不支援轉錄）`);
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
    return failed(`音檔 ${mb}MB 超過 Whisper 25MB 上限（此集太長暫不支援轉錄）`);
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: 'audio/mpeg' }), `${episodeId}.mp3`);
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
    const segments: TranscriptSegment[] = (parsedBody.segments ?? []).map((s) => ({
      id: s.id,
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    }));

    if (segments.length === 0) {
      return failed('Whisper 回傳空的 segments');
    }

    return json({ status: 'ready', segments });
  } catch (err) {
    return failed(`轉錄失敗：${String(err)}`);
  }
});
