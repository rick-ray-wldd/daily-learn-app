/**
 * 通知端出題 —— `lib/liveActivity.ts` 的**轉接層，不是第二套出題器**。
 *
 * **這個檔案的鐵律：**
 *
 *   ① **正確答案／干擾項／題面／否決理由全部沿用 `buildDeck`，一行都不重寫。**
 *      本檔只做四件事：呼叫 `buildDeck`、把 card 補上「一則通知需要的東西」
 *      （category identifier）、把選項排成**由 `card_id` 唯一決定**的固定順序
 *      （`fixOptionOrder`，理由是 category 會被重新註冊，那支的檔頭有完整論證）、
 *      把 `SkipReason` 翻成人看得懂的一句話。
 *      鎖屏卡與通知題目**必須是同一個出題器**——兩份實作分岔的那一天，
 *      「鎖屏問的」與「通知問的」會變成兩個答案不同的題目，而我們無從得知
 *      使用者答的是哪一個。（排列順序不是分岔：兩邊問的是同一題、同一個正解，
 *      只有按鈕的左右位置不同，而那本來就每次洗牌都不同。）
 *   ② **純函式、零 side effect。** 不 import `expo-notifications`、不 import
 *      `./store` / `./srs`、不碰任何原生模組。所以它可以在沒有 React、沒有網路、
 *      沒有裝置的情況下單獨測。
 *   ③ **不准自己查 store 算今日佇列**（`liveActivity.ts` 鐵律②）。佇列一律由
 *      呼叫端（`App.tsx` 的三桶）傳進來。這個 repo 已經有兩份「今天要練哪幾張」
 *      的實作而且已經分岔，第三份保證重演「徽章說有 3 張、點進去是空的」。
 *   ④ **資料不足就不出題，不准編造。** 見 `buildQuiz` 的檔頭說明。
 *
 * 為什麼一天最多三則（`MAX_QUIZ_NOTIFICATIONS = 3`）而不是鎖屏卡的 N=5：
 * 鎖屏卡是**使用者自己點開鎖定畫面才看到**的被動曝光，五張只佔一張卡的版面；
 * 通知是**主動打斷**，一天五次會被關掉通知權限，那是不可逆的損失。
 */
import { cyrb53, stableHash } from './hash';
import {
  buildDeck,
  type LiveActivityCard,
  type LiveActivityOption,
  type OptionId,
  type SkipReason,
} from './liveActivity';
import type { Capture } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 常數
// ─────────────────────────────────────────────────────────────────────────────

/** 一天最多打擾三次。分母**不是** `MAX_DECK_LENGTH`（那是鎖屏卡的 N=5），刻意更小。 */
export const MAX_QUIZ_NOTIFICATIONS = 3;

/**
 * 排程時段（local）。已經過去的時段順延到**明天**的同一時段，不准立刻發——
 * 「一開 app 就跳一則題目通知」會讓使用者把通知關掉，而通知權限拿不回來。
 *
 * 選這三個點的理由：午餐後、下班通勤、睡前。都是「手上沒事、看得下一行字」的空檔，
 * 而且與每日提醒的 08:00（`DAILY_REMINDER_HOUR`）錯開，不會兩則擠在一起。
 */
export const QUIZ_SLOTS = [
  { hour: 12, minute: 30 },
  { hour: 17, minute: 30 },
  { hour: 20, minute: 30 },
] as const;

/**
 * category identifier 的前綴。**不含 `:` 與 `-`**——官方 d.ts 明寫這兩個字元會讓
 * category 失效（`setNotificationCategoryAsync` 的 identifier 限制），而失效的樣子
 * 是「通知照發但按鈕不見了」，不會有任何錯誤訊息。
 *
 * 同時也是清理舊 category 的依據：凡是這個前綴、又不在今天清單裡的一律刪掉。
 */
export const QUIZ_CATEGORY_PREFIX = 'echoQuiz';

// ─────────────────────────────────────────────────────────────────────────────
// 型別
// ─────────────────────────────────────────────────────────────────────────────

export interface QuizQuestion {
  /** = `Capture.id`。答案回寫時的鍵。 */
  card_id: string;
  /** 通知標題，**就是英文題面本身**（見 `buildQuiz` 檔頭的「標題就是題目」）。 */
  prompt: string;
  /**
   * 恰好 3 個。順序 = 三顆按鈕由左到右，而且是**由 `card_id` 唯一決定的固定順序**
   * （不是每次洗牌）——理由見 `fixOptionOrder`。
   */
  options: LiveActivityOption[];
  correct_id: OptionId;
  /** `echoQuiz<stableHash(card_id)>`，保證 `[0-9a-z]`、無 `:` / `-`。 */
  category_id: string;
}

export type QuizBlockedReason =
  /** 今天沒有到期的卡。 */
  | 'empty-queue'
  /** 有卡但沒有 `gloss_zh`（**今天必然走這條**，見 `buildQuiz` 檔頭）。 */
  | 'no-gloss'
  | 'not-enough-distractors'
  | 'no-prompt'
  | 'other';

export interface QuizStatus {
  /** 實際排出去的通知數。**0 = 今天沒有題目，這是合法狀態**，不是失敗。 */
  scheduled: number;
  /** 每張被否決的卡與理由，原封轉自 `buildDeck`。 */
  skipped: Array<{ capture_id: string; reason: SkipReason }>;
  /** 沒排成任何題時，**最根本**的那個原因；有排到題時為 null。 */
  blocked: QuizBlockedReason | null;
  /** 開發者儀表上印的一句話（繁中）。**永遠不准說謊或美化**。 */
  summary_zh: string;
  /** ISO 8601。 */
  checked_at: string;
}

export interface BuildQuizInput {
  /** 由呼叫端給定（`App.tsx` 的三桶）。**本檔不查 store**（鐵律③）。 */
  queue: Capture[];
  /** YYYY-MM-DD（local），來自 `srs.ts` 的 `todayStr()`。 */
  today: string;
  /** 預設 `MAX_QUIZ_NOTIFICATIONS`，硬性 clamp 到 [1, 3]。 */
  maxQuestions?: number;
  /**
   * 注入式亂數，原樣轉給 `buildDeck`。
   *
   * ⚠️ **通知題目的選項順序不看它**：`buildDeck` 洗完之後，本檔會用
   * `fixOptionOrder` 重排成由 `card_id` 決定的固定順序。留著這個參數是為了與
   * `buildDeckInput` 對齊、以及讓測試能重現 `buildDeck` 內部的行為。
   */
  random?: () => number;
}

export interface BuildQuizResult {
  /** 0..maxQuestions 題。 */
  questions: QuizQuestion[];
  skipped: Array<{ capture_id: string; reason: SkipReason }>;
  blocked: QuizBlockedReason | null;
  summary_zh: string;
}

/**
 * `SkipReason` → 繁中短語（給 `summary_zh` 與開發者儀表用）。
 *
 * 用 `Record<SkipReason, string>` 而不是 `Partial<...>`：`liveActivity.ts` 之後新增
 * 一個 SkipReason 時，這裡會**編譯失敗**而不是安靜地印出 `undefined`。
 */
export const SKIP_REASON_ZH: Readonly<Record<SkipReason, string>> = {
  segmentation: '整句切分題，題面塞不進通知',
  'no-prompt': '沒有可用的題面',
  'prompt-too-long': '題面過長',
  'no-gloss': '沒有中文簡義（gloss_zh）',
  'not-enough-distractors': '干擾項不足 2 個',
  'label-too-long': '選項中文過長',
};

// ─────────────────────────────────────────────────────────────────────────────
// buildQuiz
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把今日佇列轉成 0..3 則通知題目。
 *
 * ⚠️ **現況（2026-08）：這支對真實資料必然回傳 `questions: []`、
 * `blocked: 'no-gloss'`。這是設計，不是失敗。**
 * `gloss_zh` / `distractors_zh` 這兩欄在整個 repo 裡**沒有任何生產者**
 * （`lib/diagnose.ts` 的 `validateDiagnosis` 是逐欄位重建物件，即使 Edge Function
 * 哪天開始回傳，client 這一側也會先把它丟掉），所以 `buildDeck` 必然回 `deck: null`、
 * `skipped` 全部是 `'no-gloss'`。
 *
 * **出不了題時的正確行為是「一則都不排」**，不是排一則佔位通知、更不是換個來源湊題：
 *   - 不准拿 `explanation_zh`（≤60 字）當正解——正解 60 字、干擾項 5 字，
 *     光看長度就選得對，會產出一個很漂亮的**假**正確率。
 *   - 不准跨 capture 借 gloss、不准拿同集逐字稿的其他詞、不准隨機中文詞湊干擾項——
 *     跨 capture 的語意天差地遠，干擾項一眼排除 → 95% 的假正確率，
 *     正好砸掉這個產品唯一的論點（這些數字是真的）。
 *   - 不准拿六類難點標籤當選項——那測的是「你同不同意 app 的猜測」，
 *     與「診斷延後」要消滅的錨定效應直接打架。
 * 以上禁令都落在 `buildDeck` 裡，本檔不重寫任何一條，所以也不可能繞過它們。
 */
export function buildQuiz(input: BuildQuizInput): BuildQuizResult {
  const queue = Array.isArray(input.queue) ? input.queue : [];
  // clamp 而不是丟例外：呼叫端傳 0 或 99 都是 bug，但讓通知因為它 crash 更糟。
  const maxQuestions = clamp(
    Number.isInteger(input.maxQuestions)
      ? (input.maxQuestions as number)
      : MAX_QUIZ_NOTIFICATIONS,
    1,
    MAX_QUIZ_NOTIFICATIONS,
  );

  const { deck, skipped } = buildDeck({
    queue,
    today: input.today,
    maxCards: maxQuestions,
    random: input.random,
  });

  // card → question 只多一個欄位：category_id。題面、正解、干擾項全部原樣搬
  // （鐵律①）；唯一被動到的是**選項的排列順序**，理由見 `fixOptionOrder`。
  const questions: QuizQuestion[] = (deck?.cards ?? []).map((card) => {
    const fixed = fixOptionOrder(card);
    return {
      card_id: card.card_id,
      prompt: card.prompt,
      options: fixed.options,
      correct_id: fixed.correct_id,
      category_id: QUIZ_CATEGORY_PREFIX + stableHash(card.card_id),
    };
  });

  const blocked = questions.length > 0 ? null : resolveBlocked(queue, skipped);

  return {
    questions,
    skipped,
    blocked,
    summary_zh: summarize(questions, queue, skipped, blocked),
  };
}

/**
 * 下一次 `hour:minute` 的絕對時間；**已過就是明天的同一時刻**。
 *
 * 用 `setHours` + `setDate(+1)` 而不是加 86400000 毫秒：跨日光節約時間時
 * 「明天的 12:30」不等於「24 小時後」，用毫秒加法會讓通知偏移一小時。
 */
export function nextSlotDate(
  slot: { hour: number; minute: number },
  now: Date = new Date(),
): Date {
  const hour = Number.isInteger(slot?.hour) ? clamp(slot.hour, 0, 23) : 12;
  const minute = Number.isInteger(slot?.minute) ? clamp(slot.minute, 0, 59) : 0;

  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  // `<=` 而不是 `<`：剛好等於現在就順延，避免排一個「已經到期」的觸發時間
  // （iOS 會當場發出來，那正是上面禁止的「一開 app 就跳通知」）。
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具（模組私有）
// ─────────────────────────────────────────────────────────────────────────────

const OPTION_IDS: readonly OptionId[] = ['a', 'b', 'c'];

/**
 * 三個選項的全部 6 種排列。**查表而不是再洗一次牌**——查表沒有亂數，也就沒有
 * 「這次跟上次不一樣」這件事。
 */
const PERMUTATIONS_OF_3: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/** 與 category identifier 的 `stableHash` 用同一支雜湊，只換 seed（順序不必與 id 相關）。 */
const OPTION_ORDER_SEED = 0x6f7264;

/**
 * 把選項的順序改成**由 `card_id` 唯一決定**的固定排列。
 *
 * 🔴 這是本檔唯一動到 `buildDeck` 產物的地方，理由是通知這條路獨有的：
 *
 * iOS 的按鈕標題住在 **notification category**，而 category 是一份**全域、可被覆寫**
 * 的註冊表（`setNotificationCategoryAsync` 的原生實作就是
 * `current.filter{ id≠ } ∪ {new}` 再整包 `setNotificationCategories`）。已經**發出去、
 * 還躺在通知中心**的那則通知，身上帶的是發出當下的 `option_ids` / `correct_id`，
 * 但它的按鈕是用 category identifier 現查的。
 *
 * `buildDeck` 預設用 `Math.random` 洗牌，而 `syncQuizNotifications` 每次回前景
 * （10 分鐘節流之外）都會重跑一輪、用**同一個** `category_id` 重新註冊。於是：
 * 12:30 發出一則題目 → 14:00 使用者開了一次 app → 同一張卡洗出新順序、category 被
 * 覆寫 → 18:00 他下拉那則 12:30 的通知，看到的按鈕已經不是通知身上那份答案卷。
 * 他點對了會被記成答錯，而答錯**會寫 `gradeSrsItem(item, 'again')`**——我們會拿到一筆
 * 「他不會這個」的假資料。這個 app 全部的論點就是「這些數字是真的」，所以這條路
 * 不能靠「iOS 大概是在送達時就把按鈕定住了吧」這種沒有白紙黑字的假設。
 *
 * 排列固定成 `card_id` 的純函式之後，重新註冊必然產生**一模一樣**的 category，
 * 覆寫變成 no-op，上面那個窗口就整個不存在——不管 iOS 是哪一種語意。
 *
 * 代價（明講）：同一張卡每次出現，正解都在同一顆按鈕上，理論上可以背位置。但那個
 * 代價的方向是**安全的**——背位置的人會答對，而答對**不寫 SRS**（ADR-0022⑤ 的單向
 * 寫入），最多是少收到一筆真的「他不會」；順序漂移則是**捏造**一筆假的「他不會」。
 * 少收一筆真的，遠好過多收一筆假的。
 */
function fixOptionOrder(card: LiveActivityCard): {
  options: LiveActivityOption[];
  correct_id: OptionId;
} {
  // 任何一個假設不成立就原樣退回：這支的職責是排序，不是守門，
  // 它不該有能力讓一張 buildDeck 已經核可的卡消失。
  const fallback = { options: card.options, correct_id: card.correct_id };
  if (card.options.length !== OPTION_IDS.length) return fallback;

  const correctLabel = card.options.find((o) => o.id === card.correct_id)?.label_zh;
  if (!correctLabel) return fallback;

  // 基準序必須與 buildDeck 洗出來的隨機順序**無關**，否則等於把一個固定排列套在
  // 一個隨機底盤上，結果照樣每次不同。字串排序就是那個底盤（buildDeck 已保證三個
  // label 兩兩不同，所以這個順序唯一）。
  const base = card.options
    .map((o) => o.label_zh)
    .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const perm =
    PERMUTATIONS_OF_3[cyrb53(card.card_id, OPTION_ORDER_SEED) % PERMUTATIONS_OF_3.length];
  if (!perm) return fallback;

  const options: LiveActivityOption[] = perm.map((from, i) => ({
    id: OPTION_IDS[i] as OptionId,
    label_zh: base[from] as string,
  }));
  const correct = options.find((o) => o.label_zh === correctLabel);
  // 理論上不可能——correctLabel 一定在 base 裡。真的發生就退回原樣，不准回一張
  // correct_id 指不到任何選項的卡。
  if (!correct) return fallback;

  return { options, correct_id: correct.id };
}

/**
 * `blocked` 的判定順序：**先問最根本的**。
 *
 * 順序是刻意的——佇列本來就空的時候，去回報「沒有 gloss」是誤導：那些卡根本
 * 不存在，補上 gloss 也不會有題目。`checkEligibility` 用同一套「由根到表」的邏輯。
 */
function resolveBlocked(
  queue: Capture[],
  skipped: BuildQuizResult['skipped'],
): QuizBlockedReason {
  if (queue.length === 0) return 'empty-queue';

  const dominant = dominantReason(skipped);
  switch (dominant) {
    case 'no-gloss':
      return 'no-gloss';
    case 'not-enough-distractors':
      return 'not-enough-distractors';
    case 'no-prompt':
      return 'no-prompt';
    default:
      // segmentation / prompt-too-long / label-too-long / 以及「佇列非空卻沒有
      // 任何 skip」這個理論上不可能的狀態，全部落在這裡。
      return 'other';
  }
}

/** 出現次數最多的否決理由；平手取**先出現**的（讓 summary 穩定可重現）。 */
function dominantReason(skipped: BuildQuizResult['skipped']): SkipReason | null {
  const counts = new Map<SkipReason, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);

  let best: SkipReason | null = null;
  let bestCount = 0;
  // 依原始順序掃、只在**嚴格大於**時替換 → 平手時保留先出現的那個。
  for (const s of skipped) {
    const c = counts.get(s.reason) ?? 0;
    if (c > bestCount) {
      best = s.reason;
      bestCount = c;
    }
  }
  return best;
}

function countOf(
  skipped: BuildQuizResult['skipped'],
  reason: SkipReason,
): number {
  return skipped.filter((s) => s.reason === reason).length;
}

/**
 * 開發者儀表上的那一句話。**句型固定，不要潤飾**——它的用途是讓 founder 打開 app
 * 就知道「為什麼今天沒有題目」，而不是以為功能壞了。任何美化都會讓那個判斷失準。
 */
function summarize(
  questions: QuizQuestion[],
  queue: Capture[],
  skipped: BuildQuizResult['skipped'],
  blocked: QuizBlockedReason | null,
): string {
  if (questions.length > 0) {
    const slots = questions
      .map((_, i) => formatSlot(QUIZ_SLOTS[i] ?? QUIZ_SLOTS[QUIZ_SLOTS.length - 1]))
      .join(' / ');
    return `已排 ${questions.length} 題：${slots}`;
  }

  switch (blocked) {
    case 'empty-queue':
      return '今天沒有到期的卡，所以沒有排題目通知。';
    case 'no-gloss':
      return `佇列有 ${queue.length} 張卡，但沒有一張帶中文簡義（gloss_zh）與干擾項——diagnose Edge Function 還沒生成這兩欄。今天不排題目通知：寧可沒有，也不出一則猜的題目。`;
    case 'not-enough-distractors':
      return `有 ${countOf(skipped, 'not-enough-distractors')} 張卡有正解但干擾項不足 2 個，湊不出三選一。不排通知。`;
    default: {
      const dominant = dominantReason(skipped);
      const n = dominant ? countOf(skipped, dominant) : skipped.length;
      const zh = dominant ? SKIP_REASON_ZH[dominant] : '原因不明';
      return `${n} 張卡被排除（${zh}），今天沒有可出的題目。`;
    }
  }
}

/** 12:30 這種顯示格式。兩位數補零，讓 summary 對齊好讀。 */
function formatSlot(slot: { hour: number; minute: number }): string {
  return `${`${slot.hour}`.padStart(2, '0')}:${`${slot.minute}`.padStart(2, '0')}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
