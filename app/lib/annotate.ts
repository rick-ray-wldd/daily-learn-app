/**
 * 逐字稿難詞標註 — `annotate` Edge Function 的 client seam（ADR-0008：provider
 * key 一律留在伺服器端，client 只送 segment 文字）。
 *
 * ⚠️ **標註不是訊號。**
 *
 * 標註是「app 猜」哪裡難——一個模型讀過逐字稿之後的推測。但產品的整個主張是
 * 反方向的：**學習者按下返回鍵，那才是他自己給出的證據**（CONTEXT.md §1）。
 * 一旦讓推測混進證據裡，comprehension profile 就會開始反映模型的偏見而不是這位
 * 學習者真實的弱點，而那正好是我們相對於「AI 幫你挑生詞」類產品僅有的差異。
 *
 * 所以這裡產生的 `Term`：
 *   - **不寫進 capture**（`Capture.diagnosis` 只能來自 lib/diagnose.ts，源頭是
 *     一次真實的 replay event）
 *   - **不參與** comprehension profile / signal strength / confirm rate 的計算
 *   - 不落地（見 `cache` 上的說明）
 * 它只是閱讀輔助：點一下高亮的詞，看到中文解釋，僅此而已。
 *
 * 反過來的資訊流則是允許的：`weakTypes` 把**學習者已確認**的 capture 統計回饋
 * 給模型，讓標註偏向他反覆卡住的難點類型。證據 → 推測可以，推測 → 證據不行。
 */
import { getCaptures } from './store';
import { ensureSession, supabase } from './supabase';
import { DiagnosisType, TranscriptSegment } from './types';

export interface Term {
  /** 該詞所在 segment 的 `segmentKey`（伺服器已驗證過真的出現在那句裡）。 */
  segment_id: number;
  term: string;
  type: DiagnosisType;
  explanation_zh: string;
}

/**
 * 標註狀態與 `Term.segment_id` 用的句子鍵。
 *
 * **不能用 `TranscriptSegment.id`。** Whisper 是一個 10 分鐘窗口一次呼叫，每次
 * 回來的 segment id 都從 0 重新編號，而 `functions/transcribe` 只把 start/end
 * 位移到單集時間軸、id 原樣轉發——所以第二個窗口的第一句和第一個窗口的第一句
 * 都是 id 0。拿它當鍵有兩個後果：第一個窗口標完之後 `attempted` 已經含有
 * 0..N，第二個窗口整批被當成「送過了」而永遠不送；就算送了，第一個窗口的 term
 * 也會掛到第二個窗口的句子上。
 *
 * 改用 transcript.ts 合併 segments 時真正的去重鍵（`start` 取到十分之一秒）：
 * 它在整集裡唯一，而且窗口重轉之後仍然指到同一句。是整數，可以直接當
 * `segment_id` 送進 Edge Function——伺服器只是把我們送過去的 id 原樣回報。
 */
export function segmentKey(segment: TranscriptSegment): number {
  return Math.round(segment.start * 10);
}

/**
 * 湊滿這麼多「還沒標過」的句子才值得送一次。伺服器端一次最多回 12 個詞，一句
 * 一句送會在一分鐘內燒光 40/天 的配額（見 functions/annotate/index.ts）。
 */
const BATCH_MIN_SEGMENTS = 20;
/**
 * 單批上限。12 個詞攤在 40 句上密度剛好；送 120 句進去只會得到同樣的 12 個詞，
 * 等於整個窗口只標到前面一小段。
 */
const MAX_BATCH_SEGMENTS = 40;
/**
 * 伺服器把 prompt 裡的 `[id] text` 截在 12k 字元。被截掉的句子我們這邊卻已經
 * 記成「送過了」，所以自己先切——寧可多送一批，也不要有句子從沒被讀到。
 */
const MAX_BATCH_CHARS = 10_000;
/** `[<segmentKey>] ` 前綴 + 換行的字元成本；key 是 start×10，長單集會到 6 位數。 */
const PREFIX_CHARS = 12;
/** 覆蓋範圍停止成長多久之後，把不足一批的零頭送出去。 */
const IDLE_FLUSH_MS = 5_000;
/** 回饋給模型的弱項數。挑三類以上等於沒有偏好（總共才六類）。 */
const MAX_WEAK_TYPES = 2;

const TERM_TYPES: DiagnosisType[] = [
  'vocab',
  'linking',
  'speed',
  'grammar',
  'accent',
  'culture',
];

/** 一集的標註狀態。逐批累積，鏡像 lib/transcript.ts 累積 segments 的方式。 */
interface EpisodeAnnotations {
  /** `segmentKey` → 該句的所有 term。每次合併重建（identity 變了 = UI 要重畫）。 */
  terms: Map<number, Term[]>;
  /** 已送出過的 `segmentKey`（含結果為空的）——同一句不送第二次。 */
  attempted: Set<number>;
  /** 最近一次 `ensureAnnotations` 看到的 segments；flush 時據此重算待標清單。 */
  latest: TranscriptSegment[];
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** 掛上 idle timer 當下的待標數量；沒變就不要重設倒數。 */
  armedFor: number;
}

/**
 * 只活在記憶體裡，**刻意不落地**。標註很便宜（一個窗口約 $0.005），而 `segmentKey`
 * 只在同一份逐字稿內穩定：窗口重轉時 Whisper 的斷句位置會挪動零點幾秒，存下來的
 * 標註就會掛到隔壁那句上。標錯位置比沒有標註更糟，所以寧可每次重標。
 */
const cache = new Map<string, EpisodeAnnotations>();
/** 每集同時只允許一個請求在飛，兩次快速呼叫不會重複扣配額。 */
const inFlight = new Set<string>();
const listeners = new Set<() => void>();
/** 未知單集共用同一個空 Map，讓 getTerms 的回傳 identity 保持穩定。 */
const EMPTY_TERMS: Map<number, Term[]> = new Map();

function notify(): void {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch (err) {
      console.warn('[annotate] listener error:', err);
    }
  });
}

/** Subscribe to annotation changes. Returns the unsubscribe function. */
export function subscribeAnnotations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 標註走 Edge Function，所以「能不能標」＝ Supabase 有沒有設定好。 */
export function isAnnotationConfigured(): boolean {
  return supabase !== null;
}

/** 目前已知的標註，key = `segmentKey(segment)`。UI 直接讀這個。 */
export function getTerms(episodeId: string): Map<number, Term[]> {
  return cache.get(episodeId)?.terms ?? EMPTY_TERMS;
}

function stateFor(episodeId: string): EpisodeAnnotations {
  let s = cache.get(episodeId);
  if (!s) {
    s = {
      terms: new Map(),
      attempted: new Set(),
      latest: [],
      idleTimer: null,
      armedFor: -1,
    };
    cache.set(episodeId, s);
  }
  return s;
}

/**
 * 確保 `segments` 都被標註過。Fire-and-forget：回傳 void、不 throw，失敗就是
 * 沒有標註，逐字稿照樣看得到（與 lib/diagnose.ts 同一種降級方式）。
 *
 * 呼叫端可以每次逐字稿更新就呼叫——真正送出去的時機由下面的批次規則決定。
 */
export function ensureAnnotations(
  episodeId: string,
  segments: TranscriptSegment[],
): void {
  if (!supabase || segments.length === 0) return;

  const st = stateFor(episodeId);
  st.latest = segments;

  const pending = pendingSegments(st);
  if (pending.length === 0) {
    cancelIdle(st);
    return;
  }
  // 夠一批就直接送；不夠就等——覆蓋範圍還在長的話，下一次呼叫自然湊滿。
  if (pending.length >= BATCH_MIN_SEGMENTS) {
    cancelIdle(st);
    void flush(episodeId);
    return;
  }
  armIdle(st, episodeId, pending.length);
}

/** 還沒送過、且有內容的句子（空白句送過去只會被伺服器丟掉）。 */
function pendingSegments(st: EpisodeAnnotations): TranscriptSegment[] {
  return st.latest.filter(
    (s) => !st.attempted.has(segmentKey(s)) && s.text.trim().length > 0,
  );
}

/**
 * 不足一批時的退路：覆蓋範圍停止成長就把零頭送出去（單集播到最後、暫停在窗口
 * 中間、或下一個窗口轉錄失敗）。
 *
 * 只在待標數量**改變**時重設倒數——每秒被呼叫一次都重設的話，這個 timer 永遠
 * 不會到期，零頭就永遠標不到。
 */
function armIdle(
  st: EpisodeAnnotations,
  episodeId: string,
  pendingCount: number,
): void {
  if (st.idleTimer !== null && st.armedFor === pendingCount) return;
  cancelIdle(st);
  st.armedFor = pendingCount;
  st.idleTimer = setTimeout(() => {
    st.idleTimer = null;
    void flush(episodeId);
  }, IDLE_FLUSH_MS);
}

function cancelIdle(st: EpisodeAnnotations): void {
  if (st.idleTimer === null) return;
  clearTimeout(st.idleTimer);
  st.idleTimer = null;
  st.armedFor = -1;
}

/** 下一批：待標句子依數量 / 字元上限截斷。 */
function nextBatch(st: EpisodeAnnotations): TranscriptSegment[] {
  const batch: TranscriptSegment[] = [];
  let chars = 0;
  for (const seg of pendingSegments(st)) {
    if (batch.length >= MAX_BATCH_SEGMENTS) break;
    const cost = seg.text.length + PREFIX_CHARS; // 伺服器加上的 `[id] ` 前綴與換行
    if (batch.length > 0 && chars + cost > MAX_BATCH_CHARS) break;
    batch.push(seg);
    chars += cost;
  }
  return batch;
}

async function flush(episodeId: string): Promise<void> {
  if (!supabase || inFlight.has(episodeId)) return;

  const st = stateFor(episodeId);
  if (pendingSegments(st).length === 0) return;

  inFlight.add(episodeId);
  let sent = 0;

  try {
    // 沒有 session 就整批不動（Edge Function 會 401）。之後 session 建立起來
    // 再送，所以這裡刻意不標記 attempted。
    const userId = await ensureSession();
    if (!userId) return;

    const batch = nextBatch(st);
    if (batch.length === 0) return;

    // 出手前就標記為「送過」：呼叫一旦發出就已經算進 40/天 的配額，重送只是用
    // 同樣的失敗再花一次。與 transcript.ts 的 failedWindows 是同一個政策。
    for (const seg of batch) st.attempted.add(segmentKey(seg));
    sent = batch.length;

    const weakTypes = weakTypesFromCaptures();
    const { data, error } = await supabase.functions.invoke('annotate', {
      body: {
        episodeId,
        // 送 segmentKey 而不是 Whisper 的 id：伺服器把收到的 id 原樣回報成
        // `Term.segment_id`，所以送什麼進去就決定了 `terms` 的鍵。
        segments: batch.map((s) => ({ id: segmentKey(s), text: s.text })),
        ...(weakTypes.length > 0 ? { weakTypes } : {}),
      },
    });

    if (error) {
      console.warn('[annotate] edge function failed:', error.message);
      return;
    }

    const terms = validateTerms((data as { terms?: unknown } | null)?.terms);
    if (terms.length > 0) merge(st, terms);
  } catch (err) {
    console.warn('[annotate] request failed:', err);
  } finally {
    inFlight.delete(episodeId);
    // 一個 10 分鐘窗口通常不只一批。只有真的送出去過才續送——待標數量嚴格遞減，
    // 不會無限迴圈；沒送出去（無 session）就安靜停手，等下一次呼叫。
    if (sent > 0) {
      const rest = pendingSegments(st);
      if (rest.length >= BATCH_MIN_SEGMENTS) void flush(episodeId);
      else if (rest.length > 0) armIdle(st, episodeId, rest.length);
    }
  }
}

/** 併入新 term 並通知訂閱者。 */
function merge(st: EpisodeAnnotations, terms: Term[]): void {
  // 重建 Map 而不是原地改：UI 靠 identity 判斷要不要重畫。
  const next = new Map(st.terms);
  for (const t of terms) {
    next.set(t.segment_id, [...(next.get(t.segment_id) ?? []), t]);
  }
  st.terms = next;
  notify();
}

/**
 * 伺服器已經驗過「term 真的出現在該 segment 裡」，這裡只做型別把關，不重做定位
 * 檢查。壞掉的項目個別丟掉——一個 term 的 type 拼錯不該讓整批標註消失。
 */
function validateTerms(input: unknown): Term[] {
  if (!Array.isArray(input)) return [];
  const out: Term[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    if (
      typeof t.segment_id !== 'number' ||
      typeof t.term !== 'string' ||
      typeof t.type !== 'string' ||
      !TERM_TYPES.includes(t.type as DiagnosisType) ||
      typeof t.explanation_zh !== 'string'
    ) {
      console.warn('[annotate] term failed validation:', t);
      continue;
    }
    out.push({
      segment_id: t.segment_id,
      term: t.term,
      type: t.type as DiagnosisType,
      explanation_zh: t.explanation_zh,
    });
  }
  return out;
}

/**
 * 這位學習者最常卡住的 1–2 個難點類型，回饋給模型當作標註偏好。
 *
 * 只數學習者**自己確認過**的 capture：pending 還沒經過 focus confirmation，
 * dismissed 是已經被否認掉的。`practiced` 也算——它是 confirmed 之後往前走一步
 * 的狀態（Practice.tsx 直接覆寫），漏掉它等於學習者越練，他最大的弱項越看不見。
 * 判定方式與 stats.ts 的 confirmRate 一致。
 */
function weakTypesFromCaptures(): DiagnosisType[] {
  const counts = new Map<DiagnosisType, number>();
  for (const c of getCaptures()) {
    if (c.status !== 'confirmed' && c.status !== 'practiced') continue;
    const type = c.diagnosis?.type;
    if (!type) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  // 新使用者一個都沒有 → 回空陣列，呼叫端就不帶 weakTypes（伺服器有預設行為）。
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_WEAK_TYPES)
    .map(([type]) => type);
}
