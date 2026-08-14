/**
 * Mirror 音訊階梯的**素材定位層**：從 capture 推導出離線預生成的音檔在哪，
 * 再確認它到底存不存在。播放、UI、狀態都不在這裡（那是 Practice.tsx 的事）。
 *
 * 三層階梯是這樣分工的：
 *
 *   ① Mirror·分塊   塊內原速 + thought group 邊界停頓   ← 本檔負責定位
 *   ② Mirror·慢速   原生慢速（母音與停頓拉長、子音不變）  ← 本檔負責定位
 *   ③ 原音          真實速度                            ← 用既有的 episode.audioUrl
 *
 * ③ 刻意不在 `MirrorPaths` 裡：原音不是新素材，它就是那一集本來就在播的檔案，
 * 練習頁的大綠圓鍵已經用 `playSegment` 播它了。多開一個欄位只會讓下游以為要再
 * 下載一份。
 *
 * 為什麼不是 `setPlaybackRate(0.7)`：時間伸縮把每個音段等比拉長，但真實的慢速
 * 朗讀是母音與停頓變長、子音幾乎不變。等比拉長會毀掉 tense/lax 母音的時長線索、
 * 抹開塞音爆破（偵測詞界最強的線索之一）、把 F0 輪廓拉長成假語調。而且**弱讀還是
 * 弱讀**——"wanna" 放慢仍然是 "wanna"，學習者要的是邊界，拉長不會生出邊界。
 *
 * ── 檔案鐵律 ──────────────────────────────────────────────────────────
 * 1. 只准 import `fetchWithTimeout`（`./rss` 已存在，本輪禁止新增 dependency）。
 *    不碰 store、不碰 expo-audio、不碰 React —— 路徑推導必須能在沒有 app 的
 *    情況下單獨驗證。
 * 2. `deriveMirrorPaths` 是純函式；`checkMirrorAssets` 是本檔**唯一**的 I/O，
 *    而且必須有快取與 in-flight 去重（換卡就打一次網路等於每次 render 打網路）。
 * 3. 推不出路徑就回 `null`、查不到素材就回 `'missing'`——**不准硬湊路徑**，也
 *    不准把「沒有素材」當成錯誤丟出去。素材今天一個都不存在，這是常態不是異常。
 *
 * ── 產檔命名契約（給本機 IndexTTS-2 的產檔腳本，本輪不做）─────────────────
 *     demo-media/<slug>/mirror/<round1(cue.start) * 1000>-chunked.mp3
 *     demo-media/<slug>/mirror/<round1(cue.start) * 1000>-slow.mp3
 * 也就是：與 `sentences.vtt` 同一層開一個 `mirror/` 夾，檔名是那句 cue 起點的
 * **毫秒整數**（先做 0.1 秒 round 再乘 1000）。這段契約寫在這裡是因為下一輪要寫
 * 產檔腳本的人只會讀這個檔；沒有它，他一定會自己發明一套命名，然後兩邊永遠對不上。
 */
import { fetchWithTimeout } from './rss';

/**
 * 只有這兩級的 window 邊界是 VTT cue 的邊界（`commitSelection` / `commitSavedTerm`
 * 都是 `round1(segment.start)`），離線預生成才算得出檔名。
 *
 * `weak` / `strong` 是倒帶來的窗口——起點是 T−15 的任意浮點，事後還會被
 * `windowsOverlap` 合併收窄，永遠對不上任何一句 cue 的起點。
 *
 * ⚠️ 白名單，不准改寫成 `!== 'weak'`（types.ts 的鐵律）：黑名單會讓將來新增的
 * 級別預設被算進來，然後拿一個對不上的 key 去猜檔名。
 */
export const MIRROR_ELIGIBLE_STRENGTHS = ['selected', 'saved'] as const;

/** 只有自家 demo-media 的素材才可能有預生成的 mirror 檔；別人的 CDN 一律放棄。 */
const DEMO_MEDIA_MARKER = '/storage/v1/object/public/demo-media/';
const MIRROR_DIR = 'mirror';
/** HEAD 很輕，但素材不存在時不值得讓使用者等——6 秒到就當沒有。 */
const MIRROR_TIMEOUT_MS = 6_000;

export interface MirrorPaths {
  /** 檔名前綴（毫秒整數字串）。對帳與除錯用，播放端不需要理解它。 */
  key: string;
  chunkedUrl: string;
  slowUrl: string;
}

export type MirrorAvailability = 'ready' | 'missing';

/** 與 `lib/selection.ts:32` 的 round1 一字不差：差一點點就會生出 123.40000000000001。 */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * capture 的 `window_start` + 該集的 `transcriptUrl` → mirror 音檔的兩支 URL。
 *
 * 推不出來就回 `null`（呼叫端據此整個區塊不顯示）。**任何一條不確定就放棄**：
 * 猜錯路徑的下場不是 404，而是播出一句「聽起來很合理但根本是別句」的音檔——
 * 那是最難被發現的一種錯。
 *
 * ⚠️ `capture.id` 不准當 key：它是裝置端當場 `uuidv4()` 生的，離線預生成不可能
 * 事先知道。key 只能是內容本身算得出來的東西，也就是那句 cue 的起點。
 */
export function deriveMirrorPaths(input: {
  transcriptUrl?: string;
  windowStart: number;
}): MirrorPaths | null {
  const { transcriptUrl, windowStart } = input;

  if (typeof transcriptUrl !== 'string' || transcriptUrl.length === 0) return null;
  // 帶 query string 的 CDN URL（例如 Planet Money 那筆 enclosure）盲切最後一個 '/'
  // 之後的東西，會把 query 的一部分當成檔名，生出垃圾路徑。
  if (transcriptUrl.includes('?')) return null;
  if (!transcriptUrl.includes(DEMO_MEDIA_MARKER)) return null;

  const slash = transcriptUrl.lastIndexOf('/');
  // slash <= 0：沒有 '/' 或只在開頭；slash 在最後一格：'/' 後面沒有檔名。
  if (slash <= 0 || slash === transcriptUrl.length - 1) return null;

  if (!Number.isFinite(windowStart) || windowStart < 0) return null;

  const base = transcriptUrl.slice(0, slash); // …/demo-media/huberman-memory
  // 先 round1 再轉毫秒整數：與 capture 寫進 store 的精度同一套，否則浮點尾巴會
  // 讓同一句話在不同裝置上算出不同檔名。
  const key = String(Math.round(round1(windowStart) * 1000));

  return {
    key,
    chunkedUrl: `${base}/${MIRROR_DIR}/${key}-chunked.mp3`,
    slowUrl: `${base}/${MIRROR_DIR}/${key}-slow.mp3`,
  };
}

/**
 * 快取（key = chunkedUrl）。
 *
 * `'missing'` **也要快取**：不快取的話每次換卡都重打兩次網路，而今天的實情是
 * 每一張卡都 missing。代價是素材上架後要重開 app（或呼叫 `resetMirrorCache`）
 * 才看得到——prototype 階段可以接受。
 */
const availability = new Map<string, MirrorAvailability>();
/** in-flight 去重，照抄 `transcript.ts:59-60` 的模式：同一張卡連續 render 只打一次。 */
const inFlight = new Map<string, Promise<MirrorAvailability>>();
/**
 * 世代編號：`resetMirrorCache()` 之後，那些還在天上飛的舊查詢回來時不准再寫進
 * 快取（否則「清掉快取」會被一個清掉之前就發出的結果默默還原）。
 */
let generation = 0;

/** 兩支一起判定，永遠不 throw：任何非 ok / 逾時 / 網路爆炸都只是「沒有素材」。 */
async function probe(
  paths: MirrorPaths,
  fetcher: (url: string, timeoutMs: number, init?: RequestInit) => Promise<Response>,
): Promise<MirrorAvailability> {
  try {
    const results = await Promise.all([
      fetcher(paths.chunkedUrl, MIRROR_TIMEOUT_MS, { method: 'HEAD' }),
      fetcher(paths.slowUrl, MIRROR_TIMEOUT_MS, { method: 'HEAD' }),
    ]);
    // 兩支都在才算 ready：只有慢速沒有分塊的半套階梯，讀起來就是壞掉。
    return results.every((res) => res.ok) ? 'ready' : 'missing';
  } catch {
    // ⚠️ 這裡刻意連 console.warn 都不印：素材不存在是今天的常態，印了只會洗版，
    // 把真正該看的 warning 淹掉。
    return 'missing';
  }
}

/**
 * 這兩支音檔存在嗎？
 *
 * 用 HEAD 而不是 GET：只要知道在不在，不要為了一個布林把 mp3 抓下來。
 * ⚠️ Supabase Storage 物件不存在時**不一定回 404**（常見 400），所以判定只看
 * `res.ok`，任何非 ok 一律當「沒有素材」——不准當錯誤顯示給使用者，也不准 throw。
 *
 * `fetcher` 可注入純粹是為了可測（預設就是 `fetchWithTimeout`）。
 */
export function checkMirrorAssets(
  paths: MirrorPaths,
  fetcher: (
    url: string,
    timeoutMs: number,
    init?: RequestInit,
  ) => Promise<Response> = fetchWithTimeout,
): Promise<MirrorAvailability> {
  const key = paths.chunkedUrl;

  const cached = availability.get(key);
  if (cached) return Promise.resolve(cached);

  const pending = inFlight.get(key);
  if (pending) return pending;

  const gen = generation;
  const task = probe(paths, fetcher).then((result) => {
    // 世代對得上才動兩張表：reset 之後 inFlight 已經被清空，這時再 delete(key)
    // 會誤刪 reset 之後才登記的那筆新查詢。
    if (gen === generation) {
      availability.set(key, result);
      inFlight.delete(key);
    }
    return result;
  });
  inFlight.set(key, task);
  return task;
}

/** 素材剛上架時清掉快取用（開發者入口／測試）。飛在天上的查詢結果一併作廢。 */
export function resetMirrorCache(): void {
  generation += 1;
  availability.clear();
  inFlight.clear();
}
