/**
 * Episode model + hardcoded demo episodes for the W1 core-loop prototype.
 *
 * The demo UUIDs are fixed and match the seed rows in
 * `supabase/migrations/001_init.sql`, so replay_events inserts satisfy the
 * episodes FK when Supabase is configured.
 *
 * RSS 來的單集 id = 'rss-' + stableHash(guid || 'enc:' + enclosureUrl)
 * （見 lib/rss.ts）——guid 優先，保證 feed 重抓 id 不變且 file-path 安全。
 */
export interface Episode {
  /** Demo: fixed UUID（DB seed 一致）；RSS: `rss-<hash>`（file-safe）。 */
  id: string;
  podcast: string;
  title: string;
  audioUrl: string;
  /** Rough duration in seconds; 未知時 0（UI 有 duration>0 防護）。 */
  durationSec: number;
  guid?: string;
  /** ISO 8601（parse 失敗則 undefined）。 */
  pubDate?: string;
  /** RSS enclosure length attr（可能缺/為 0）。 */
  enclosureBytes?: number;
  /** podcast:transcript srt/vtt 的 url（僅支援型別時設）。 */
  transcriptUrl?: string;
  transcriptType?: 'srt' | 'vtt';
  /** DEMO 為 undefined。 */
  feedUrl?: string;
  artworkUrl?: string;
}

export const DEMO_EPISODES: Episode[] = [
  // 放第一個：它是唯一有現成逐字稿的示範集，開 app 就看得到跟播效果，
  // 不用等 Whisper 轉完（另外兩集沒有 transcriptUrl，走轉錄路徑）。
  //
  // 音檔與 vtt 都放在 Supabase Storage 的 demo-media，兩者同源（YouTube 版），
  // 所以時間軸完全對齊。RSS enclosure 版本有動態插入的廣告，時間會偏，不能混用。
  // ⚠️ 這是 prototype 的示範素材，不是產品內容管線 —— 見 scripts/vtt_to_sentences.py。
  {
    id: '33333333-3333-4333-8333-333333333333',
    podcast: 'Huberman Lab Essentials',
    title: 'Understand & Improve Memory Using Science-Based Tools',
    audioUrl:
      'https://lkywohepzbubiijxktai.supabase.co/storage/v1/object/public/demo-media/huberman-memory/audio.mp3',
    durationSec: 2149,
    transcriptUrl:
      'https://lkywohepzbubiijxktai.supabase.co/storage/v1/object/public/demo-media/huberman-memory/sentences.vtt',
    transcriptType: 'vtt',
    artworkUrl: 'https://i.ytimg.com/vi/U6dnOVth7-I/maxresdefault.jpg',
  },
  {
    id: '11111111-1111-4111-8111-111111111111',
    podcast: 'Planet Money (NPR)',
    title: 'Seven allegedly fake Chanel bags vs The RealReal',
    audioUrl:
      'https://npr.simplecastaudio.com/43b5acee-463e-4612-95ad-d2596d9dd337/episodes/a5a22e7a-4cac-46c1-b29b-d5dbebba9027/audio/128/default.mp3?awCollectionId=43b5acee-463e-4612-95ad-d2596d9dd337&awEpisodeId=a5a22e7a-4cac-46c1-b29b-d5dbebba9027&feed=hvWWWzRv',
    durationSec: 1538,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    podcast: 'LibriVox Audiobook',
    title: 'The Art of War — Ch. 1–2 (Sun Tzu)',
    audioUrl:
      'https://archive.org/download/art_of_war_librivox/art_of_war_01-02_sun_tzu_64kb.mp3',
    durationSec: 506,
  },
];
