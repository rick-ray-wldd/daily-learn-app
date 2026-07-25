/**
 * RSS feed 抓取與解析 — fast-xml-parser v4（純 JS，Expo Go/Hermes 安全）。
 *
 * Episode id 穩定性約定（核心）：
 *   id = 'rss-' + stableHash(guid存在 ? guid : 'enc:' + enclosureUrl)
 * guid 優先 → 同一 feed 重抓同 guid → 同 id，captures.episode_id 永遠有效。
 * 例外：同一 feed 內 guid 重複但 enclosure 不同（壞 feed）→ 後出現者退回用
 * 'enc:' + enclosureUrl 計算，保住 capture 歸屬正確；guid+enclosure 都相同
 * 的真重複則以 id 去重（保留 pubDate 較新者）。
 * 不混入 feedUrl（feed 搬家時 id 不變）；雜湊而非原文（guid 可能是含 / ? 的
 * URL，會弄壞 transcript.ts 的檔名路徑）。
 */
import { XMLParser } from 'fast-xml-parser';

import { Episode } from './episodes';
import { stableHash } from './hash';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false, // 關鍵：guid/duration 不被轉成 number；CDATA 照常變字串
  isArray: (name, jpath) =>
    jpath === 'rss.channel.item' || name === 'podcast:transcript',
});

export interface ParsedFeed {
  title: string;
  author?: string;
  artworkUrl?: string;
  episodes: Episode[]; // 已排序（pubDate desc）、已截 20
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** "HH:MM:SS" | "MM:SS" | "1538" | 1538 → 秒；解析不了回 0。 */
export function parseItunesDuration(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
  if (typeof raw !== 'string' || !raw.trim()) return 0;
  const parts = raw.trim().split(':').map((p) => parseFloat(p));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
  if (parts.length === 1) return Math.round(parts[0]);
  if (parts.length === 2) return Math.round(parts[0] * 60 + parts[1]);
  if (parts.length === 3) return Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  return 0;
}

/** RFC2822 具名時區 → UTC offset（分鐘）。RFC5322 建議未知具名時區當 UTC。 */
const NAMED_TZ_OFFSET_MIN: Record<string, number> = {
  EST: -5 * 60,
  EDT: -4 * 60,
  CST: -6 * 60,
  CDT: -5 * 60,
  MST: -7 * 60,
  MDT: -6 * 60,
  PST: -8 * 60,
  PDT: -7 * 60,
};

/** RFC2822 pubDate → ISO。不要依賴 Date.parse（Hermes 對非 ISO 格式支援不穩）。 */
export function parsePubDate(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const m = raw.match(
    /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:(UT|GMT|UTC|Z)|(EST|EDT|CST|CDT|MST|MDT|PST|PDT)|([+-])(\d{2})(\d{2}))?/i,
  );
  if (!m) {
    const t = Date.parse(raw); // ISO 格式 fallback（Hermes 支援 ISO）
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const mon = months.indexOf(m[2].toLowerCase());
  let ts = Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], m[6] ? +m[6] : 0);
  if (m[8]) {
    // 美系具名時區（EST/PDT…）：UTC = local − offset。其餘不明具名時區
    // 不會被 regex 捕到 → 維持 UTC fallback。
    ts -= NAMED_TZ_OFFSET_MIN[m[8].toUpperCase()] * 60_000;
  } else if (m[9]) {
    const off = (+m[10] * 60 + +m[11]) * 60_000;
    ts += m[9] === '-' ? off : -off;
  }
  return new Date(ts).toISOString();
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && '#text' in v) {
    return textOf((v as Record<string, unknown>)['#text']);
  }
  return '';
}

const SRT_TYPES = ['application/srt', 'application/x-subrip', 'text/srt'];
const VTT_TYPES = ['text/vtt', 'application/x-vtt'];

interface TranscriptTag {
  '@_url'?: unknown;
  '@_type'?: unknown;
}

/** 掃 podcast:transcript 標籤：SRT 優先於 VTT；type 缺時用副檔名推斷。 */
function pickTranscript(
  tags: TranscriptTag[],
): { url: string; type: 'srt' | 'vtt' } | undefined {
  const typed = tags
    .map((t) => ({
      url: typeof t['@_url'] === 'string' ? (t['@_url'] as string) : '',
      mime: typeof t['@_type'] === 'string' ? (t['@_type'] as string).toLowerCase() : '',
    }))
    .filter((t) => t.url.length > 0);

  const isSrt = (t: { url: string; mime: string }) =>
    SRT_TYPES.includes(t.mime) || (!t.mime && /\.srt(\?|$)/i.test(t.url));
  const isVtt = (t: { url: string; mime: string }) =>
    VTT_TYPES.includes(t.mime) || (!t.mime && /\.vtt(\?|$)/i.test(t.url));

  const srt = typed.find(isSrt);
  if (srt) return { url: srt.url, type: 'srt' };
  const vtt = typed.find(isVtt);
  if (vtt) return { url: vtt.url, type: 'vtt' };
  return undefined;
}

/** 失敗一律 throw Error（中文訊息），呼叫端 catch 顯示。逾時 15s。 */
export async function fetchAndParseFeed(feedUrl: string): Promise<ParsedFeed> {
  let res: Response;
  try {
    res = await fetchWithTimeout(feedUrl, 15_000);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('抓取 RSS 逾時（15 秒）');
    }
    throw new Error('抓取 RSS 失敗：' + String(err));
  }
  if (!res.ok) throw new Error(`RSS 伺服器回應 ${res.status}`);

  const xml = await res.text();
  if (xml.length > 8 * 1024 * 1024) throw new Error('RSS 檔案過大');

  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml) as Record<string, any>;
  } catch {
    throw new Error('RSS 格式解析失敗');
  }
  const channel = doc?.rss?.channel;
  if (!channel) throw new Error('這不是有效的 podcast RSS');

  const channelTitle = textOf(channel.title) || '(未命名節目)';
  const author = textOf(channel['itunes:author']) || undefined;
  const itunesImage = channel['itunes:image']?.['@_href'];
  const artworkUrl =
    (typeof itunesImage === 'string' && itunesImage.length > 0
      ? itunesImage
      : undefined) ?? (textOf(channel.image?.url) || undefined);

  const items: Array<Record<string, any>> = Array.isArray(channel.item)
    ? channel.item
    : [];

  const mapped: Array<{ ep: Episode; ts: number; idx: number }> = [];
  const guidToEnclosure = new Map<string, string>(); // guid → 第一次見到的 enclosureUrl
  items.forEach((item, idx) => {
    // 少數 feed 會給多個 enclosure（parser 只在重複時回陣列）→ 取第一個
    const enclosure = Array.isArray(item.enclosure)
      ? item.enclosure[0]
      : item.enclosure;
    const enclosureUrl = enclosure?.['@_url'];
    if (typeof enclosureUrl !== 'string' || enclosureUrl.length === 0) return; // 無 enclosure → skip

    const guid = textOf(item.guid);
    // guid 重複但 enclosure 不同（壞 feed 的「不同集共用 guid」）→ 退回用
    // enclosureUrl 計 id，確保 capture 歸屬不會兩集互撞。
    let idKey = guid || 'enc:' + enclosureUrl;
    if (guid) {
      const firstEnclosure = guidToEnclosure.get(guid);
      if (firstEnclosure === undefined) {
        guidToEnclosure.set(guid, enclosureUrl);
      } else if (firstEnclosure !== enclosureUrl) {
        idKey = 'enc:' + enclosureUrl;
      }
    }
    const id = 'rss-' + stableHash(idKey);

    const rawLength = enclosure?.['@_length'];
    const parsedBytes = parseInt(typeof rawLength === 'string' ? rawLength : '', 10);
    const enclosureBytes =
      Number.isFinite(parsedBytes) && parsedBytes > 0 ? parsedBytes : undefined;

    const transcriptTags: TranscriptTag[] = Array.isArray(item['podcast:transcript'])
      ? (item['podcast:transcript'] as TranscriptTag[])
      : [];
    const transcript = pickTranscript(transcriptTags);

    const pubDate = parsePubDate(item.pubDate);
    const ep: Episode = {
      id,
      podcast: channelTitle,
      title: textOf(item.title) || '(未命名單集)',
      audioUrl: enclosureUrl,
      durationSec: parseItunesDuration(item['itunes:duration']),
      guid: guid || undefined,
      pubDate,
      enclosureBytes,
      transcriptUrl: transcript?.url,
      transcriptType: transcript?.type,
      feedUrl,
      artworkUrl,
    };
    mapped.push({ ep, ts: pubDate ? Date.parse(pubDate) : 0, idx });
  });

  // 同 id（guid+enclosure 全同的真重複）去重：保留 pubDate 較新者。
  const byId = new Map<string, { ep: Episode; ts: number; idx: number }>();
  for (const entry of mapped) {
    const prev = byId.get(entry.ep.id);
    if (!prev || entry.ts > prev.ts) byId.set(entry.ep.id, entry);
  }
  const deduped = [...byId.values()];
  deduped.sort((a, b) => (b.ts !== a.ts ? b.ts - a.ts : a.idx - b.idx));
  const episodes = deduped.slice(0, 20).map((m) => m.ep);
  if (episodes.length === 0) throw new Error('這個 feed 沒有可播放的單集');

  return { title: channelTitle, author, artworkUrl, episodes };
}
