/**
 * 英語難度分級 —— 用**免費、離線、可解釋**的訊號估一個 1–5 的帶。
 *
 * ## 為什麼不叫 CEFR
 *
 * CEFR 是對**人**的分級，不是對音訊的。把一個節目標成 "B2" 是在宣稱一件我們量
 * 不到的事——真正的 CEFR 映射要靠詞表（EFLLex 之類）＋ IRT，而那需要一份授權
 * 資料集與一整套估計流程。這裡標的是**難度帶**，講的是「這段對聽力的負荷有多大」，
 * 不假裝它是語言能力框架。
 *
 * ## 三個訊號，全部免費
 *
 * 1. **語速（wpm）—— 權重最高。**
 *    Tauroza & Allison (1990) 給的英語對話基準是 190–230 wpm；Griffiths (1990)
 *    顯示快速語音顯著損害 L2 理解；Hamada (2019) 指出 shadowing 的即時性要求會在
 *    輸入太快時壓垮認知資源。語速是文獻上最一致的單一預測因子，而它從逐字稿
 *    **直接算得出來**，不需要任何外部資料。
 *
 * 2. **詞彙多樣性（TTR）與平均詞長。**
 *    ⚠️ TTR 與樣本長度高度相關，所以一律在**固定的前 TTR_SAMPLE 個 token** 上算，
 *    不然長單集會系統性地看起來比較簡單。平均詞長是拉丁語源／學術詞彙的粗略代理。
 *
 * 3. **實聽倒帶密度（每 10 分鐘幾次）—— 最準，但只有聽過才有。**
 *    這是 Echo 獨有的訊號：它量的不是「這段有多難」，而是「這段**對你**有多難」。
 *
 * ## 刻意不做的
 *
 * - **不內嵌詞頻表。** 前 1000 高頻詞的覆蓋率確實是聽力理解的強預測因子
 *   （SSLLT：與切分能力合起來解釋 34–38% 變異），但憑記憶生一份「近似的 GSL」
 *   然後拿它當數字用，是在製造一個看起來精確的假象。要做就接真的 EFLLex。
 * - **不從節目簡介猜。** 簡介是行銷文案，與實際口說的語速和用詞沒有必然關係。
 * - **不對沒有任何依據的東西給等級。** 沒資料就回 `null`，UI 顯示「未評估」。
 *   一個瞎猜的等級比沒有等級更糟——它會讓學習者照著錯的難度挑材料。
 */
import type { TranscriptSegment } from './types';

/** 1 最易、5 最難。 */
export type Level = 1 | 2 | 3 | 4 | 5;

/** 這個等級是**量出來的**還是**猜的**。UI 必須把兩者畫得不一樣。 */
export type LevelBasis =
  /** 只有節目類型可用——最弱的依據，純屬先驗。 */
  | 'genre'
  /** 從實際逐字稿算出語速與詞彙指標。 */
  | 'transcript'
  /** 從這位學習者自己的倒帶密度算出來——最準，而且是個人化的。 */
  | 'listened';

export interface LevelEstimate {
  level: Level;
  basis: LevelBasis;
  /** 一句話說明它憑什麼。直接顯示給使用者看，不要藏在 tooltip 裡。 */
  reason_zh: string;
  /** `genre` 是猜的，其餘兩種是量的。 */
  measured: boolean;
}

export const LEVEL_LABEL_ZH: Record<Level, string> = {
  1: '入門',
  2: '初階',
  3: '中階',
  4: '中高階',
  5: '進階',
};

// ─────────────────────────────────────────────────────────────────────────────
// 語速與詞彙指標
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TTR 的固定取樣長度。**不要改成「全部 token」**——TTR 隨樣本變長必然下降，
 * 那會讓 60 分鐘的單集系統性地被評得比 10 分鐘的簡單。
 */
const TTR_SAMPLE = 500;

/** 少於這個 token 數就不夠算，回 null 而不是給一個抖動的數字。 */
const MIN_TOKENS = 120;

export interface TranscriptMetrics {
  /** 每分鐘字數。 */
  wpm: number;
  /** 前 TTR_SAMPLE 個 token 的 type-token ratio。 */
  ttr: number;
  /** 平均詞長（字元）。 */
  meanWordLen: number;
  tokens: number;
  /** 逐字稿實際涵蓋的秒數（不是單集長度——窗口化轉錄只有部分）。 */
  coveredSec: number;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z'\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

/**
 * 從逐字稿片段算出三個指標。**片段可以是不連續的**（窗口化轉錄的常態），
 * 所以涵蓋時間是每段長度的**總和**而不是首尾相減——後者會把沒轉錄到的空隙
 * 也算進分母，語速直接被稀釋成一半。
 */
export function computeTranscriptMetrics(
  segments: readonly TranscriptSegment[],
): TranscriptMetrics | null {
  if (segments.length === 0) return null;

  let coveredSec = 0;
  const allWords: string[] = [];
  for (const s of segments) {
    const dur = s.end - s.start;
    if (dur > 0 && Number.isFinite(dur)) coveredSec += dur;
    allWords.push(...words(s.text));
  }

  if (allWords.length < MIN_TOKENS || coveredSec < 30) return null;

  const sample = allWords.slice(0, TTR_SAMPLE);
  const unique = new Set(sample).size;
  const totalChars = allWords.reduce((n, w) => n + w.length, 0);

  return {
    wpm: (allWords.length / coveredSec) * 60,
    ttr: unique / sample.length,
    meanWordLen: totalChars / allWords.length,
    tokens: allWords.length,
    coveredSec,
  };
}

/**
 * 三個指標 → 難度帶。
 *
 * 語速給最高權重（0.6），因為它是文獻上最一致的預測因子；TTR 與平均詞長各 0.2，
 * 它們是詞彙負荷的代理但雜訊較大（專有名詞多的單集會把兩者一起推高）。
 *
 * 語速的分界照 Tauroza & Allison 的對話基準往下鋪：190–230 是母語者常速，
 * 對 L2 聽者已經偏快，所以 190 以上直接落在最高兩帶。
 */
export function levelFromMetrics(m: TranscriptMetrics): LevelEstimate {
  const speed = band(m.wpm, [130, 160, 190, 215]);
  const variety = band(m.ttr, [0.34, 0.4, 0.46, 0.52]);
  const wordLen = band(m.meanWordLen, [4.1, 4.4, 4.7, 5.0]);

  const score = speed * 0.6 + variety * 0.2 + wordLen * 0.2;
  const level = clampLevel(Math.round(score) + 1);

  return {
    level,
    basis: 'transcript',
    measured: true,
    reason_zh: `語速 ${Math.round(m.wpm)} wpm・詞彙多樣性 ${m.ttr.toFixed(2)}`,
  };
}

/** 值落在哪一段，回 0..4。 */
function band(v: number, edges: [number, number, number, number]): number {
  if (v < edges[0]) return 0;
  if (v < edges[1]) return 1;
  if (v < edges[2]) return 2;
  if (v < edges[3]) return 3;
  return 4;
}

function clampLevel(n: number): Level {
  if (n <= 1) return 1;
  if (n >= 5) return 5;
  return n as Level;
}

// ─────────────────────────────────────────────────────────────────────────────
// 實聽訊號（最準，個人化）
// ─────────────────────────────────────────────────────────────────────────────

/** 低於這麼多分鐘的實聽時間不足以推斷，回 null。 */
const MIN_LISTENED_MIN = 5;

/**
 * 倒帶密度 → 難度帶。**這個等級是相對於這位學習者的**，不是絕對難度。
 *
 * 分界是產品判斷不是文獻常數：每 10 分鐘 0–1 次代表輕鬆跟得上；5 次以上代表
 * 幾乎每兩分鐘就卡一次，那個材料現在對他太難。真實資料進來之後要回來校準。
 */
export function levelFromListening(
  rewinds: number,
  listenedMinutes: number,
): LevelEstimate | null {
  if (listenedMinutes < MIN_LISTENED_MIN) return null;
  const per10 = (rewinds / listenedMinutes) * 10;
  const level = clampLevel(band(per10, [1, 2.5, 4, 6]) + 1);
  return {
    level,
    basis: 'listened',
    measured: true,
    reason_zh: `你每 10 分鐘倒帶 ${per10.toFixed(1)} 次`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 類型先驗（最弱，只在完全沒有其他資料時用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * iTunes 的 `primaryGenreName` → 先驗難度。
 *
 * ⚠️ 這是**猜的**，而且是很粗的猜。它存在的唯一理由是：搜尋結果裡的節目使用者
 * 一集都還沒聽過，除了類型什麼都沒有。UI 必須把它畫得比量出來的等級弱
 * （`measured: false`），不然學習者會以為那是測出來的。
 */
const GENRE_PRIOR: Array<{ match: RegExp; level: Level; why: string }> = [
  { match: /kids|family|children/i, level: 1, why: '兒童節目語速慢、用詞淺' },
  { match: /language|learning|education/i, level: 2, why: '教學類通常放慢並重述' },
  { match: /fiction|story|drama/i, level: 3, why: '敘事類語速中等但用詞多樣' },
  { match: /comedy|society|culture|arts/i, level: 4, why: '談話與喜劇語速快、慣用語多' },
  { match: /news|politic|business|tech|science|health|medic/i, level: 4, why: '新聞與專業題材術語密度高' },
];

export function levelFromGenre(genre?: string): LevelEstimate | null {
  if (!genre) return null;
  for (const g of GENRE_PRIOR) {
    if (g.match.test(genre)) {
      return { level: g.level, basis: 'genre', measured: false, reason_zh: g.why };
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 彙整
// ─────────────────────────────────────────────────────────────────────────────

export interface LevelInputs {
  genre?: string;
  segments?: readonly TranscriptSegment[];
  listened?: { rewinds: number; minutes: number };
}

/**
 * 取**最可信**的那一個，優先序：實聽 > 逐字稿 > 類型。全都沒有就回 null。
 *
 * 為什麼實聽排第一而不是把三個平均：它們量的不是同一件事。逐字稿量的是材料的
 * 絕對難度，實聽量的是「對這個人」的難度——後者才是挑材料時真正要的答案。
 * 平均會讓一個他明明聽得很吃力的節目因為語速慢而被評成簡單。
 */
export function estimateLevel(input: LevelInputs): LevelEstimate | null {
  if (input.listened) {
    const l = levelFromListening(input.listened.rewinds, input.listened.minutes);
    if (l) return l;
  }
  if (input.segments && input.segments.length > 0) {
    const m = computeTranscriptMetrics(input.segments);
    if (m) return levelFromMetrics(m);
  }
  return levelFromGenre(input.genre);
}
