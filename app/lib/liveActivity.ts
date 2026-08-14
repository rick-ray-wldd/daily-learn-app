/**
 * 鎖定畫面複習卡（EchoReview Live Activity）的 **JS 側純邏輯**。
 *
 * **這個檔案的鐵律，違反任何一條都會讓它變成別的東西：**
 *
 *   ① **純型別 + 純函式、零 side effect。** 不 import 原生模組、不碰 `NativeModules`、
 *      不碰 `AppState` / `store` / `srs` / `notifications`、不做 I/O、不發網路請求。
 *      唯一的 import 是 `./types` 的 **type-only** import（編譯後不留 require）。
 *      原生模組這一輪還沒編譯過，import 它會讓 `expo export` 當場爆掉。
 *   ② **不准自己算「今天要複習哪幾張」。** deck 的來源一律由呼叫端傳進來。
 *      ADR-0017 已記載「今天的算不算」目前有**兩份**實作（`screens/Practice.tsx` 的
 *      佇列 vs `App.tsx` 的 `computeBadge`）而且已經分岔；本檔若自己再算一次就是
 *      第三份，保證重演「徽章說有 3 張、點進去是空的」。
 *   ③ **不准 export 任何會推進 SRS 的東西。** 鎖屏答對**不是** `practiced`、不呼叫
 *      `gradeSrsItem`、不計入 daily session 完成度、不進北極星。理由見下面的「④」。
 *
 * ④ 為什麼③是鐵律而不是偏好（ADR-0021 落地前，這段話就是那份 ADR）：
 *    北極星是「每週完成的 daily session」，ADR-0011 存在的**全部理由**就是不讓「滑一滑」
 *    算成完成。一次鎖屏三選一點擊的證據強度遠低於練習頁的完整流程（重聽 → 揭露 →
 *    跟讀 → 自評），而且猜對率本來就有 1/3。把它記成 practiced 等於用一次點擊灌水
 *    北極星，正好做出 ADR-0011 要消滅的那個 vanity number。鎖屏答題是**額外曝光**，
 *    只做統計（`summarizeAnswers`），不做評分。
 *
 * ⑤ 版面是**三選一 + 想不起來**：一列三個選項（1 正解 + 2 干擾）＋ 獨立一列的逃生口，
 *    共 4 顆按鈕、猜對率 1/3。逃生口不是第四個選項，它是「我不知道」——把它算成選項
 *    會讓猜對率變 1/2，那個數字測不到任何東西。
 *
 * ⑥ 按鈕走 iOS 17+ 的 `LiveActivityIntent`，Apple 明訂它跑在 **app 的行程**裡。
 *    所以正確說法是「**不進前景**」，**不是**「不喚醒 app」——後者是錯的，寫進
 *    pitch 會被問倒。好消息是 `perform()` 是純 Swift、不需要 JS runtime 起來。
 */
import type { Capture, Diagnosis } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 常數（跨語言契約：改這裡就要同步改 Swift 的 EchoAppGroup 與 plugin）
// ─────────────────────────────────────────────────────────────────────────────

/** 與 `EchoAppGroup.identifier`、`plugins/withEchoWidget.js` 的 `DEFAULT_APP_GROUP` 三處一致。 */
export const APP_GROUP_ID = 'group.com.rickray.echo';
/** App Group 容器根目錄下的答案目錄。intent 寫、app 收割後刪。 */
export const ANSWER_DIR_NAME = 'live-activity-answers';
/** UserDefaults key：整副牌（含正解）。**唯一 writer 是前景 app**。 */
export const DECK_KEY = 'echo.liveActivity.deck.v1';
/** UserDefaults key：已答到第幾張（0-based）。**唯一 writer 是 intent**。 */
export const CURSOR_KEY = 'echo.liveActivity.cursor.v1';
/** 下一輪 local Expo module 的名字。本檔只宣告，**絕不 require**。 */
export const NATIVE_MODULE_NAME = 'EchoLiveActivity';
/** 答案檔的 schema 版本。缺或不等於它 → 丟棄並 warn，不要猜。 */
export const ANSWER_SCHEMA_VERSION = 1;
/** ADR-0011 的 N=5。分母永遠是它，**不准出現 10**。 */
export const MAX_DECK_LENGTH = 5;
/** 一張卡恰好三個選項（1 正解 + 2 干擾）。逃生口不算在內。 */
export const OPTIONS_PER_CARD = 3;
/** 題面上限。超過在鎖定畫面會截字，且擠掉底下兩列按鈕。 */
export const PROMPT_MAX_CHARS = 48;
/** 單一選項的中文字上限——一列要塞三顆，超過就截字。 */
export const OPTION_LABEL_MAX_CHARS = 8;
/** 互動按鈕的實質下限（Live Activity 本身是 16.2，但沒有按鈕就沒有這個功能）。 */
export const MIN_IOS_VERSION = 17;
/** Live Activity header 左側的來源標籤。 */
export const DEFAULT_SOURCE_LABEL = 'Echo · 今日複習';

// ─────────────────────────────────────────────────────────────────────────────
// 型別
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 選項的穩定鍵。**刻意不用 index**：換題時 index 會重用，按鈕帶著舊 index 回來
 * 就會把答案記到別題頭上。
 */
export type OptionId = 'a' | 'b' | 'c';
/** 使用者按下去的東西。'unknown' = 逃生口「想不起來」。 */
export type ChosenId = OptionId | 'unknown';

export interface LiveActivityOption {
  id: OptionId;
  /** ≤ OPTION_LABEL_MAX_CHARS 個字。 */
  label_zh: string;
}

export interface LiveActivityCard {
  /** = `Capture.id`。答案回寫時就是這個鍵。 */
  card_id: string;
  /** 英文題面。**永遠不是整句逐字稿**（來源優先序見 `buildDeck`）。 */
  prompt: string;
  /** 恰好 OPTIONS_PER_CARD 個，順序已洗過。 */
  options: LiveActivityOption[];
  /**
   * 正解。**只存在於 App Group 的 deck 快照，絕不進 ContentState** ——
   * ContentState 是會被序列化、未來可能經 push 傳輸的載體。
   */
  correct_id: OptionId;
}

export interface LiveActivityDeck {
  /** = `deck_date`（一天一副）。 */
  deck_id: string;
  /** YYYY-MM-DD（local）。 */
  deck_date: string;
  source_label: string;
  /** 1..MAX_DECK_LENGTH 張。**空的時候不准啟動 Live Activity**。 */
  cards: LiveActivityCard[];
}

/**
 * 一筆鎖屏答題。**這個形狀與 Swift 的 `EchoAnswerRecord` 一對一對應**，
 * 改一邊就要改另一邊（JSON key 一律 snake_case）。
 */
export interface LiveActivityAnswer {
  schema_version: number;
  /**
   * `EchoAppGroup.answerId(deckId:cardId:)` 產出的**穩定鍵**，不是 UUID。
   *
   * 一開始寫的是 `UUID()`，但那樣連按兩下同一顆按鈕會落成兩個檔名、兩筆帳。
   * 改成由 (deck_id, card_id) 決定之後，檔名就是 `<answer_id>.json`——
   * 「一張卡最多一筆帳」變成**檔案系統層級**的不變式，就算兩次點擊真的撞在
   * 一起、都通過了 intent 內的檢查，同名檔最後仍然只有一份。
   *
   * 所以它同時是冪等鍵：重複收割不會重複計分。
   */
  answer_id: string;
  deck_id: string;
  card_id: string;
  chosen_id: ChosenId;
  /** `chosen_id === 'unknown'` 時恆為 false。 */
  correct: boolean;
  /** ISO 8601，**含時區**。 */
  answered_at: string;
  source: 'lockscreen' | 'dynamic-island';
}

/**
 * 這兩欄現在**已經**在 `lib/types.ts` 的 `Diagnosis` 上（optional），本型別留著只是
 * 為了讓本檔的讀者一眼看到「出題需要的到底是哪兩欄」。`DiagnosisWithGloss` 因此
 * 等價於 `Diagnosis`，兩者可以互換。
 *
 * ⚠️ `Diagnosis.explanation_zh` 是「為什麼這句難」的 ≤60 字說明，**不是** gloss。
 * 拿它當正解會讓正解 60 字、干擾項 5 字，光看長度就能選對——卡片當場失去測驗價值，
 * 卻會產出一個很漂亮的假正確率。**明令禁止。**
 *
 * 生產者鏈（三段都已完成，2026-08-14）：
 *   ① `Diagnosis` 的 optional `gloss_zh` / `distractors_zh`（`lib/types.ts`）
 *   ② diagnose Edge Function 生成它們，並在 server 端過三道閘（型別字數標點單一詞 →
 *      字面重疊 → 盲測複核）
 *   ③ `lib/diagnose.ts` 的 client validator 把它們讀進來（逐欄位重建物件，不 spread）
 */
export interface DiagnosisGloss {
  /** ≤ OPTION_LABEL_MAX_CHARS 字，這個片語**在這句話裡**的意思。與 explanation_zh 不同。 */
  gloss_zh?: string;
  /**
   * 恰好 2 個「近似但錯」的干擾項。必須**預先生成**——intent 跑在鎖定畫面上、
   * 不能連網，現算是不可能的。
   */
  distractors_zh?: string[];
}
/** optional 是必要的：舊 capture 沒有這兩欄，缺 = 「還沒生成」而不是空字串。 */
export type DiagnosisWithGloss = Diagnosis & DiagnosisGloss;

// ─────────────────────────────────────────────────────────────────────────────
// buildDeck — 唯一的資料轉換入口
// ─────────────────────────────────────────────────────────────────────────────

export type SkipReason =
  /** `selection_kind === 'segmentation'`：斷點不在詞義上，整類排除。 */
  | 'segmentation'
  /** 沒有 `diagnosis.focus_phrase` ——**通常代表這張卡還沒被診斷過**。 */
  | 'no-prompt'
  /** 題面超過 PROMPT_MAX_CHARS。 */
  | 'prompt-too-long'
  /** `diagnosis.gloss_zh` 不存在：舊格式的 diagnosis，或這次診斷不是 vocab。 */
  | 'no-gloss'
  /** 去掉與正解重複的之後，干擾項不足 2 個。 */
  | 'not-enough-distractors'
  /** 任一選項超過 OPTION_LABEL_MAX_CHARS。 */
  | 'label-too-long';

export interface BuildDeckInput {
  /** 由呼叫端給定的今日佇列。本檔**絕不**自行查 store（鐵律②）。 */
  queue: Capture[];
  /** YYYY-MM-DD（local）。同時作為 deck_id。 */
  today: string;
  sourceLabel?: string;
  /** 預設 MAX_DECK_LENGTH，硬性 clamp 到 [1, MAX_DECK_LENGTH]。 */
  maxCards?: number;
  /** 注入式亂數，讓選項順序可測。回傳 [0,1)。 */
  random?: () => number;
}

export interface BuildDeckResult {
  /** 一張都湊不出來就是 null。**null 時呼叫端不准啟動 Live Activity。** */
  deck: LiveActivityDeck | null;
  /** 每一張被排除的卡與理由——這是唯一能看出「為什麼今天沒有卡」的地方。 */
  skipped: Array<{ capture_id: string; reason: SkipReason }>;
}

/**
 * 把今日佇列轉成一副鎖屏複習卡。**輸入為空、或一張都湊不出來，回傳 `deck: null`
 * 而不是空 deck、更不是丟例外。**
 *
 * ⚠️ 現況（2026-08-14）：`gloss_zh` / `distractors_zh` 已經有生產者（diagnose Edge
 * Function），但**只有重新診斷過的 capture 才會帶著它們**。線上 15 筆裡 14 筆連
 * `diagnosis` 都沒有（落在 `'no-prompt'`），唯一那筆是舊格式（落在 `'no-gloss'`）。
 * 所以今天真實資料仍然回 `deck: null`，只是理由已經**不是**「沒有生產者」。
 *
 * 空的時候回 null 永遠是正確行為，不是 bug：**資料到位前 Live Activity 就不該啟動。**
 * 啟動它本身就是「你有事要做」的宣稱，拿空的或假的卡去兌現那個宣稱，會直接砸掉
 * 這個產品唯一的論點。
 */
export function buildDeck(input: BuildDeckInput): BuildDeckResult {
  const skipped: BuildDeckResult['skipped'] = [];
  const cards: LiveActivityCard[] = [];

  const random = input.random ?? Math.random;
  const sourceLabel = input.sourceLabel ?? DEFAULT_SOURCE_LABEL;
  // clamp 而不是丟例外：呼叫端傳 0 或 99 都是 bug，但讓鎖屏卡因為它 crash 更糟。
  const maxCards = clamp(
    Number.isInteger(input.maxCards) ? (input.maxCards as number) : MAX_DECK_LENGTH,
    1,
    MAX_DECK_LENGTH,
  );

  if (!DATE_RE.test(input.today)) {
    // 不擋——deck_id 只要唯一就能運作——但這通常代表呼叫端沒用 srs.ts 的 todayStr()。
    console.warn('[liveActivity] today is not YYYY-MM-DD:', input.today);
  }

  for (const capture of input.queue) {
    // 額滿就停。**剩下的不記進 skipped** ——它們沒有不合格，只是今天輪不到，
    // 記成 skipped 會讓那份清單從「為什麼做不出卡」變成一份看不懂的雜訊。
    if (cards.length >= maxCards) break;

    const built = buildCard(capture, random);
    if ('reason' in built) {
      skipped.push({ capture_id: capture.id, reason: built.reason });
    } else {
      cards.push(built.card);
    }
  }

  if (cards.length === 0) return { deck: null, skipped };

  return {
    deck: {
      deck_id: input.today,
      deck_date: input.today,
      source_label: sourceLabel,
      cards,
    },
    skipped,
  };
}

/** 單張卡的組裝與否決。回傳 union，讓「為什麼被否決」不可能被呼叫端忽略。 */
function buildCard(
  capture: Capture,
  random: () => number,
): { card: LiveActivityCard } | { reason: SkipReason } {
  // ① segmentation 整類排除：他說的是「我連把聲音切成詞都做不到」，那個斷點不在
  //    任何一個詞的**詞義**上。拿一題中文詞義三選一去問他，測到的不是他的斷點，
  //    但答錯照樣會寫 SRS。（`HomeScreen.tsx` 已經為了膠囊寫過一次同樣的排除。）
  if (capture.selection_kind === 'segmentation') return { reason: 'segmentation' };

  // ② 題面**只能**是 `diagnosis.focus_phrase`（規定，不准改）。
  //
  //    這裡原本的第一順位是 `selection_text`（他親手圈的字），理由是 schema 裡只有
  //    它天生就是短片語。那條路是錯的，而且錯得很安靜：
  //    正解是 `gloss_zh`，而 `gloss_zh` 是**針對 focus_phrase** 生成的，
  //    `selection_text` 從頭到尾沒有進過診斷（`screens/Practice.tsx` 只送
  //    `{ sentence, context }`），focus_phrase 是模型自己從整句挑的。兩者**可以指向
  //    不同的詞**——`types.ts` 的 SelectionKind 檔頭就明文說它們可以不一致，而且那個
  //    不一致本身是有價值的資料。實測同一句話兩次診斷分別給出
  //    "pharmacology, pharmacologic substance" 與 "spike adrenaline"，都不是使用者圈的字。
  //
  //    後果：題面印「alpha GPC」，三顆按鈕卻是 "spike" 的三個選項——**一顆都不對**。
  //    使用者無論按哪顆，2/3 被判錯 → `lib/notifications.ts` 寫下
  //    `gradeSrsItem(item, 'again')`，我們拿到一筆捏造的「他不會 alpha GPC」；
  //    剩下 1/3 判對，記下的是「他知道 alpha GPC 是迅速提升」，一樣是假的。
  //
  //    要讓他圈的字回到題面上，正確做法是**把 selection_text 一起送進診斷**、讓
  //    focus_phrase 對齊他圈的字，而不是在這裡把兩個不同來源的東西湊成一題。
  //    `transcript_text` 同樣**永遠不准**當題面，那是整句。
  const prompt = trimmed(capture.diagnosis?.focus_phrase);

  if (!prompt) return { reason: 'no-prompt' };
  if (charCount(prompt) > PROMPT_MAX_CHARS) return { reason: 'prompt-too-long' };

  // ③ 正解與干擾項，由 diagnose Edge Function 生成（見檔頭現況說明）。
  const diagnosis = capture.diagnosis as DiagnosisWithGloss | undefined;
  const gloss = trimmed(diagnosis?.gloss_zh);
  if (!gloss) return { reason: 'no-gloss' };

  const rawDistractors = Array.isArray(diagnosis?.distractors_zh)
    ? diagnosis.distractors_zh
    : [];
  // 去掉空白、與正解字面相同的、以及彼此重複的。**兩個一模一樣的選項 = 兩個正解**，
  // 那張卡的答案無法解讀，寧可整張不做。
  const distractors: string[] = [];
  for (const raw of rawDistractors) {
    if (typeof raw !== 'string') continue;
    const value = trimmed(raw);
    if (!value || value === gloss || distractors.includes(value)) continue;
    distractors.push(value);
    if (distractors.length === OPTIONS_PER_CARD - 1) break;
  }
  if (distractors.length < OPTIONS_PER_CARD - 1) {
    // **不准**臨時拿「其他 capture 的 diagnosis」或隨機中文詞來湊：跨 capture 的語意
    // 天差地遠，干擾項一眼就能排除，會產出 95% 正確率的假數字。湊不出來就不做這張。
    return { reason: 'not-enough-distractors' };
  }

  const labels = [gloss, ...distractors];
  if (labels.some((l) => charCount(l) > OPTION_LABEL_MAX_CHARS)) {
    return { reason: 'label-too-long' };
  }

  // ④ 洗牌後依序指派 id，correct_id 指向 gloss 落到的那一格。
  const shuffled = shuffle(labels, random);
  const options: LiveActivityOption[] = shuffled.map((label_zh, i) => ({
    id: OPTION_IDS[i] as OptionId,
    label_zh,
  }));
  const correct = options.find((o) => o.label_zh === gloss);
  // 理論上不可能——gloss 一定在 shuffled 裡，而且重複項已在上面濾掉。
  if (!correct) return { reason: 'not-enough-distractors' };

  return {
    card: {
      card_id: capture.id,
      prompt,
      options,
      correct_id: correct.id,
    },
  };
}

const OPTION_IDS: readonly OptionId[] = ['a', 'b', 'c'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─────────────────────────────────────────────────────────────────────────────
// payload 建構（start / update / end）
// ─────────────────────────────────────────────────────────────────────────────

/** 對應 Swift `EchoReviewAttributes.ContentState`。**沒有 correct_id**（刻意）。 */
export interface LiveActivityContentState {
  card_id: string;
  /** 1-based，用於 header 的「3/5」。 */
  card_index: number;
  prompt: string;
  /** finished 時為 []。 */
  options: LiveActivityOption[];
  /**
   * 前一題答對了嗎。第一題是 null。
   * 為什麼把「回饋」塞進下一題的 state：一次 `perform()` 只做一次 `update()`，
   * 先揭曉再換題會需要兩次，那會踩 iOS 18 的更新節流預算。
   */
  last_answer_correct: boolean | null;
  /** 前一題答錯時要顯示的正解中文。答對或第一題為 null。 */
  last_correct_label_zh: string | null;
  /** 整副牌答完。true 時版面切成結算、options 為空。 */
  finished: boolean;
}

export interface LiveActivityStartPayload {
  /** 對應 `EchoReviewAttributes` 的**靜態**欄位：活動存活期間不可變。 */
  attributes: { deck_id: string; source_label: string; deck_length: number };
  state: LiveActivityContentState;
  /** ISO 8601。過了就顯示「打開 Echo 更新今天的卡」。 */
  stale_date: string;
  /** 完整 deck（含 correct_id），原生端寫進 App Group 的 DECK_KEY 供 intent 讀。 */
  deck: LiveActivityDeck;
}

export interface LiveActivityUpdatePayload {
  state: LiveActivityContentState;
  stale_date: string;
}

export type LiveActivityEndReason =
  | 'deck-finished'
  | 'deck-stale'
  | 'harvested'
  | 'user-disabled';

export interface LiveActivityEndPayload {
  reason: LiveActivityEndReason;
  /** 'default' | 'immediate' | ISO 8601（在該時間點之後移除）。 */
  dismissal: 'default' | 'immediate' | string;
  /** 最後一幕（可選）。 */
  state?: LiveActivityContentState;
}

/**
 * 第一張卡的啟動 payload。
 *
 * **空 deck 會丟例外，這是刻意的。** 啟動 Live Activity 本身就是「你有事要做」的
 * 宣稱；空的時候既有的每日通知（`lib/notifications.ts`）已經覆蓋這個情境。
 * 靜默回傳一個空 payload 只會讓呼叫端順手做出那個被明令禁止的動作。
 */
export function buildStartPayload(args: {
  deck: LiveActivityDeck;
  staleDate: string;
}): LiveActivityStartPayload {
  const { deck, staleDate } = args;
  const first = deck.cards[0];
  if (!first) {
    throw new Error(
      '[liveActivity] buildStartPayload called with an empty deck — 空 deck 不准啟動 Live Activity',
    );
  }

  return {
    attributes: {
      deck_id: deck.deck_id,
      source_label: deck.source_label,
      // 分母永遠是實際張數（≤ MAX_DECK_LENGTH）。**不准寫死 10。**
      deck_length: deck.cards.length,
    },
    state: {
      card_id: first.card_id,
      card_index: 1,
      prompt: first.prompt,
      options: first.options,
      last_answer_correct: null,
      last_correct_label_zh: null,
      finished: false,
    },
    stale_date: staleDate,
    deck,
  };
}

/**
 * 換到下一題（或結算）的 payload。
 *
 * 這支在 JS 端存在的理由是**可測性與對帳**：真正跑在鎖定畫面上的那條路徑是
 * `EchoAnswerIntent.perform()` 的 Swift 版本。兩邊的規則必須一模一樣，任何一邊改了
 * 都要同步——這是刻意接受的重複，因為 extension 讀不到 JS。
 */
export function buildUpdatePayload(args: {
  deck: LiveActivityDeck;
  /** 0-based 下一張的索引。>= cards.length ⇒ finished。 */
  nextIndex: number;
  lastAnswerCorrect: boolean | null;
  lastCorrectLabelZh: string | null;
  staleDate: string;
}): LiveActivityUpdatePayload {
  const { deck, lastAnswerCorrect, lastCorrectLabelZh, staleDate } = args;

  let nextIndex = args.nextIndex;
  if (!Number.isInteger(nextIndex) || nextIndex < 0) {
    console.warn('[liveActivity] invalid nextIndex, falling back to 0:', args.nextIndex);
    nextIndex = 0;
  }

  const next = nextIndex < deck.cards.length ? deck.cards[nextIndex] : undefined;

  const state: LiveActivityContentState = next
    ? {
        card_id: next.card_id,
        card_index: nextIndex + 1,
        prompt: next.prompt,
        options: next.options,
        last_answer_correct: lastAnswerCorrect,
        last_correct_label_zh: lastCorrectLabelZh,
        finished: false,
      }
    : {
        // 結算畫面：沒有題目、沒有按鈕，但仍要揭曉最後一題的對錯。
        card_id: '',
        card_index: deck.cards.length,
        prompt: '',
        options: [],
        last_answer_correct: lastAnswerCorrect,
        last_correct_label_zh: lastCorrectLabelZh,
        finished: true,
      };

  return { state, stale_date: staleDate };
}

/**
 * 結束活動的 payload。
 *
 * `finished === true` **不會**自動觸發這支——結算畫面要停在鎖定畫面上直到 staleDate
 * 或使用者滑掉。JS 端在下次前景收割完才決定要不要 end。
 */
export function buildEndPayload(args: {
  reason: LiveActivityEndReason;
  finalState?: LiveActivityContentState;
}): LiveActivityEndPayload {
  // 使用者自己關掉才立刻移除；其餘讓系統照預設淡出，避免畫面突然消失。
  const dismissal = args.reason === 'user-disabled' ? 'immediate' : 'default';
  return args.finalState
    ? { reason: args.reason, dismissal, state: args.finalState }
    : { reason: args.reason, dismissal };
}

/**
 * 下一次 staleDate = **明天**的每日提醒時點（預設 08:00）。
 *
 * 為什麼不是「8 小時後」：Live Activity 本來就會在約 8 小時後被系統結束、約 12 小時後
 * 從鎖定畫面移除；staleDate 的用途是「**內容**過期」而不是「活動結束」。我們要的語意是
 * 「跨過提醒時點的題目就不該再作答」——過了那個點，今天的佇列已經換了一批。
 *
 * `reminderHour` 由呼叫端傳入（`DAILY_REMINDER_HOUR`），**不 import
 * `lib/notifications.ts`**：那支會拉進 expo-notifications 與 store，違反鐵律①。
 */
export function nextStaleDate(now: Date, reminderHour: number): string {
  const hour = Number.isInteger(reminderHour) ? clamp(reminderHour, 0, 23) : 8;
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// 收割端純函式
// ─────────────────────────────────────────────────────────────────────────────

const CHOSEN_IDS: ChosenId[] = ['a', 'b', 'c', 'unknown'];
const ANSWER_SOURCES: LiveActivityAnswer['source'][] = ['lockscreen', 'dynamic-island'];

/**
 * 驗證一筆從 App Group 讀回來的原始 JSON。
 *
 * 風格刻意對齊 `lib/diagnose.ts` 的 `validateDiagnosis`：逐欄位檢查型別 → 失敗就
 * warn 並回 null → 成功時**逐欄位重建物件**（不 spread，避免夾帶未知欄位進 app）。
 */
export function parseAnswer(input: unknown): LiveActivityAnswer | null {
  if (!input || typeof input !== 'object') {
    console.warn('[liveActivity] answer failed validation:', input);
    return null;
  }
  const d = input as Record<string, unknown>;

  if (
    d.schema_version !== ANSWER_SCHEMA_VERSION ||
    typeof d.answer_id !== 'string' ||
    d.answer_id.length === 0 ||
    typeof d.deck_id !== 'string' ||
    typeof d.card_id !== 'string' ||
    typeof d.chosen_id !== 'string' ||
    !CHOSEN_IDS.includes(d.chosen_id as ChosenId) ||
    typeof d.correct !== 'boolean' ||
    typeof d.answered_at !== 'string' ||
    Number.isNaN(Date.parse(d.answered_at)) ||
    typeof d.source !== 'string' ||
    !ANSWER_SOURCES.includes(d.source as LiveActivityAnswer['source'])
  ) {
    // schema_version 缺或 ≠ 1 也走這條：**丟棄並 warn，不要猜**。
    console.warn('[liveActivity] answer failed validation:', d);
    return null;
  }

  const chosen_id = d.chosen_id as ChosenId;
  // 「想不起來」永遠不算答對。這裡**正規化而不是否決**：使用者確實按了那顆按鈕，
  // 為了寫檔端的一個 bug 把真實的一次按壓整筆丟掉，代價比修正這個欄位大得多。
  const correct = chosen_id === 'unknown' ? false : d.correct;
  if (chosen_id === 'unknown' && d.correct) {
    console.warn('[liveActivity] unknown answer claimed correct, forcing false:', d.answer_id);
  }

  return {
    schema_version: ANSWER_SCHEMA_VERSION,
    answer_id: d.answer_id,
    deck_id: d.deck_id,
    card_id: d.card_id,
    chosen_id,
    correct,
    answered_at: d.answered_at,
    source: d.source as LiveActivityAnswer['source'],
  };
}

/** 批次驗證。`rejected` 是被丟掉的筆數——非零就代表寫檔端與這裡的契約有落差。 */
export function parseAnswers(input: unknown[]): {
  answers: LiveActivityAnswer[];
  rejected: number;
} {
  const answers: LiveActivityAnswer[] = [];
  let rejected = 0;
  for (const raw of input) {
    const parsed = parseAnswer(raw);
    if (parsed) answers.push(parsed);
    else rejected += 1;
  }
  return { answers, rejected };
}

/**
 * 用 `answer_id` 去重。已處理過的 id 由呼叫端持有（AsyncStorage）。
 *
 * 一題一檔 + UUID 檔名的整個設計就是為了這一步天然成立：收割到一半被中斷、
 * 或刪檔失敗導致下次重讀，都**不會**重複計分。
 */
export function dedupeAnswers(
  seenAnswerIds: ReadonlySet<string>,
  answers: LiveActivityAnswer[],
): { fresh: LiveActivityAnswer[]; duplicates: number } {
  const fresh: LiveActivityAnswer[] = [];
  // 同一批內部也要去重：兩個檔案帶同一個 answer_id 就是重複，不是兩次作答。
  const withinBatch = new Set<string>();
  let duplicates = 0;

  for (const a of answers) {
    if (seenAnswerIds.has(a.answer_id) || withinBatch.has(a.answer_id)) {
      duplicates += 1;
      continue;
    }
    withinBatch.add(a.answer_id);
    fresh.push(a);
  }
  return { fresh, duplicates };
}

/**
 * 只做統計。**回傳裡沒有任何 SRS 相關的東西，而且永遠不會有**（檔頭鐵律③）。
 *
 * 這三個數字的用途是「昨晚鎖定畫面上發生了什麼」，不是「他練了幾張」。
 * 要把它顯示給使用者時也請用額外曝光的措辭，不要跟 daily session 的進度混排。
 */
export function summarizeAnswers(answers: LiveActivityAnswer[]): {
  answered: number;
  correct: number;
  unknown: number;
} {
  let correct = 0;
  let unknown = 0;
  for (const a of answers) {
    if (a.chosen_id === 'unknown') unknown += 1;
    else if (a.correct) correct += 1;
  }
  return { answered: answers.length, correct, unknown };
}

// ─────────────────────────────────────────────────────────────────────────────
// 原生模組介面（**只宣告，不實作、不 require**）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 下一輪的 local Expo module 表面。**本檔只宣告形狀，絕不呼叫它**——模組還沒編譯過，
 * import 它會讓 `npx expo export` 當場失敗。
 *
 * 呼叫端必須 feature-detect（用 `checkEligibility`）：`runtimeVersion` 走 `sdkVersion`
 * policy，加 native target **不會**改 runtimeVersion，所以新的 JS bundle 一定會被推到
 * 還沒有這個 extension 的舊 build 上（與 `lib/selection.ts` 檔頭記載的「JS bundle 一定
 * 比 SQL 早到」是同一類風險）。模組不在就整段跳過，不准 crash。
 *
 * TODO（下一輪，`app/modules/echo-live-activity/`）：
 *   - `areActivitiesEnabled` → `ActivityAuthorizationInfo().areActivitiesEnabled`
 *   - `start`  → 先把 `payload.deck` 用 snake_case JSON 寫進 App Group 的 `DECK_KEY`
 *                （**唯一 writer 是前景 app**），再 `Activity.request(attributes:content:)`
 *   - `update` → `activity.update(ActivityContent(state:staleDate:))`
 *   - `end`    → `activity.end(_:dismissalPolicy:)`
 *   - `listAnswers`   → 列 `<AppGroupContainer>/live-activity-answers/*.json` 逐檔讀
 *   - `deleteAnswers` → 只刪**成功處理過**的那幾個 answer_id
 *   - `readCursor`    → 讀 `CURSOR_KEY`（對帳用；**真相是檔案，不是這個數字**）
 */
export interface EchoLiveActivityNativeModule {
  areActivitiesEnabled(): Promise<boolean>;
  /** → activityId */
  start(payload: LiveActivityStartPayload): Promise<string>;
  update(activityId: string, payload: LiveActivityUpdatePayload): Promise<void>;
  end(activityId: string, payload: LiveActivityEndPayload): Promise<void>;
  listActivityIds(): Promise<string[]>;
  /** 回原始 JSON，驗證交給 `parseAnswers`。 */
  listAnswers(): Promise<unknown[]>;
  /** → 實際刪掉的檔數。 */
  deleteAnswers(answerIds: string[]): Promise<number>;
  readCursor(): Promise<number | null>;
}

export type EligibilityReason =
  | 'not-ios'
  | 'ios-too-old'
  | 'native-module-missing'
  | 'activities-disabled'
  | 'empty-deck';

/**
 * 能不能啟動今天的鎖屏複習卡。**純函式：環境由呼叫端量測後傳進來**，本函式不自己
 * 去問系統（`Platform.OS` / `Device` / 原生模組都是 side effect）。
 *
 * 檢查順序是刻意的：先問便宜且確定的（平台、版本），再問要跨橋的（模組、授權），
 * 最後才問資料。這樣 `reason` 永遠指向**最根本**的那個原因，而不是最表面的那個。
 */
export function checkEligibility(env: {
  /** `Platform.OS` */
  os: string;
  /** 量不到就傳 null。 */
  iosMajorVersion: number | null;
  hasNativeModule: boolean;
  /** 還沒問過就傳 null。 */
  activitiesEnabled: boolean | null;
  deckLength: number;
}): { ok: boolean; reason?: EligibilityReason } {
  if (env.os !== 'ios') return { ok: false, reason: 'not-ios' };

  // null（量不到）也算太舊：**證明不了 ≥ 17 就不啟動**。16.4–16.9 會看到一個沒有
  // 按鈕、無法作答的 Live Activity——那種降級體驗比不顯示更糟。
  if (env.iosMajorVersion === null || env.iosMajorVersion < MIN_IOS_VERSION) {
    return { ok: false, reason: 'ios-too-old' };
  }

  if (!env.hasNativeModule) return { ok: false, reason: 'native-module-missing' };

  // 同理，null（還沒問到）不當成「可以」。
  if (env.activitiesEnabled !== true) {
    return { ok: false, reason: 'activities-disabled' };
  }

  // 最後一道：空 deck 不准啟動（`buildDeck` 回 null 時就是這條）。
  if (!Number.isInteger(env.deckLength) || env.deckLength <= 0) {
    return { ok: false, reason: 'empty-deck' };
  }

  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 小工具（模組私有）
// ─────────────────────────────────────────────────────────────────────────────

/** 用 code point 數，中文與 emoji 都算一個「字」。 */
function charCount(s: string): number {
  return Array.from(s).length;
}

/** 去頭尾空白；空字串一律當成「沒有這個值」。 */
function trimmed(s: string | undefined | null): string {
  return typeof s === 'string' ? s.trim() : '';
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Fisher-Yates。`random` 是注入的，所以測試可以固定順序。 */
function shuffle<T>(items: T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    // 防禦注入的 random 回傳越界值（測試常傳 1 或 -0.1），越界會讓 j 落到陣列外。
    // NaN 必須在 clamp **之前**擋掉，不能只靠 clamp：NaN 的所有比較都是 false，
    // 所以它會原封不動穿過 `n < lo ? … : n > hi ? … : n` 三個分支。後果不是 crash
    // 而是安靜的資料損壞——`out[NaN]` 讀出 undefined、`out[NaN] = tmp` 在陣列上長出
    // 一個叫 "NaN" 的屬性，最後送上鎖定畫面的是一張帶著 `label_zh: undefined` 的卡
    // （三顆按鈕有一顆沒有字）。而且它逃得過上面所有守門：長度檢查在洗牌**之前**跑，
    // `correct_id` 也照樣指得到正解，所以那張壞卡會被判定為完全合格。
    const raw = Math.floor(random() * (i + 1));
    const j = Number.isFinite(raw) ? clamp(raw, 0, i) : 0;
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}
