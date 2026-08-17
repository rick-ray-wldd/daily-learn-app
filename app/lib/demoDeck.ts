/**
 * 示範題庫 —— 給 demo 用的預設難點，**永遠不進 store**。
 *
 * ## 為什麼不寫進 store
 *
 * `syncQuizNotifications(queue)` 收的是一個**傳進去的陣列**，不是自己去查 store。
 * 所以示範題可以直接餵給它，而 `getCaptures()` 一筆都不會多。這件事很重要：
 *
 *   - 首頁漏斗、倒帶確認率、難點總數、`weakTypesFromCaptures` 全部讀 store，
 *     示範資料進去就會污染**這個 repo 唯一的賣點——那些數字是真的**。
 *   - `PodcastBrowser.episodeLevel()` 用 `getCaptures()` 算「實聽」難度帶，
 *     混進 5 筆假的會讓某一集的等級當場跳掉。
 *
 * 而下游是安全的：`harvestQuizResponse` 第一件事就是
 * `getCapture(card_id)`，查不到就回 `srs_skip: 'card-missing'` 並且**一個字都不寫**。
 * 所以示範題可以按、可以看回饋，但推不動任何 SRS。這不是巧合，是那支函式本來就
 * 為了「換裝置／卡被刪」寫的防線，示範模式剛好走在同一條路上。
 *
 * ## 這些題目憑什麼長這樣
 *
 * 每一張都經過 `buildCard`（`liveActivity.ts`）的同一組閘：
 *
 *   - 題面只能是 `diagnosis.focus_phrase`，≤ 48 字
 *   - 正解是 `gloss_zh`，≤ 8 字
 *   - 至少 2 個 `distractors_zh`，各 ≤ 8 字，且與正解字面不同、彼此不重複
 *
 * **干擾項是刻意挑成會混淆的**：多半是那個片語的**字面直譯**（"bear with me" →
 * 「忍受我」、"ballpark figure" →「球場人數」）。這是聽力真正會犯的錯——把慣用語
 * 拆成單字去理解。隨便湊三個不相干的中文詞會產出 95% 的假正確率，那正是
 * ADR-0022 明文禁止的事，示範資料也不例外。
 *
 * ## 內容選擇
 *
 * 全部是**連音與慣用語**類的聽力難點，不是課本單字——那是 Echo 的主張。
 * 第一筆 `pharmacology` 是**真的**：來自 08-08 那筆真實 capture（`c8355dc4`）的
 * 診斷結果，gloss 與干擾項都是 diagnose v4 生成的。其餘四筆是為 demo 手寫的。
 */
import type { Capture, Diagnosis } from './types';

/** 示範 capture 的 id 前綴。用來在 UI 上辨識，**不用來做任何邏輯分岔**。 */
export const DEMO_ID_PREFIX = 'demo-';

export function isDemoCaptureId(id: string): boolean {
  return id.startsWith(DEMO_ID_PREFIX);
}

interface DemoSpec {
  slug: string;
  /** 這一段假想的原句，只放進 `transcript_text` 當展示用上下文。 */
  sentence: string;
  diagnosis: Required<Pick<Diagnosis, 'type' | 'focus_phrase' | 'gloss_zh' | 'distractors_zh'>> &
    Pick<Diagnosis, 'explanation_zh' | 'practice_tip_zh'>;
}

const SPECS: readonly DemoSpec[] = [
  {
    // ⬇︎ 唯一一筆真實資料：capture c8355dc4，08-08 的倒帶，diagnose v4 生成。
    slug: 'pharmacology',
    sentence:
      "Now, it's vitally important to point out that you do not need pharmacology to do this.",
    diagnosis: {
      type: 'vocab',
      focus_phrase: 'pharmacology',
      gloss_zh: '藥物學',
      distractors_zh: ['病理學', '心理學'],
      explanation_zh: '學術領域名詞，字尾 -ology 讓三個選項聽起來很像，要靠字根分辨。',
      practice_tip_zh: '把 pharma- / patho- / psycho- 三個字根分開唸一次。',
    },
  },
  {
    slug: 'bear-with-me',
    sentence: "Bear with me for a second while I pull up the data.",
    diagnosis: {
      type: 'culture',
      focus_phrase: 'bear with me',
      gloss_zh: '請稍等',
      // 「忍受我」是把片語拆成單字的直譯——聽力真正會犯的錯。
      distractors_zh: ['忍受我', '跟我來'],
      explanation_zh: '慣用語。拆成 bear + with + me 會得到「忍受我」，語意完全跑掉。',
      practice_tip_zh: '整塊記，不要拆字。它等於 please wait a moment。',
    },
  },
  {
    slug: 'cut-corners',
    sentence: "We probably shouldn't have cut corners on the testing phase.",
    diagnosis: {
      type: 'vocab',
      focus_phrase: 'cut corners',
      gloss_zh: '便宜行事',
      // 「抄近路」是字面義，也是最容易被選的錯誤答案。
      distractors_zh: ['抄近路', '精雕細琢'],
      explanation_zh: '比喻用法，指為了省時省錢而降低品質，通常帶負面評價。',
      practice_tip_zh: '注意它幾乎都跟 shouldn’t / don’t 一起出現。',
    },
  },
  {
    slug: 'off-the-top',
    sentence: "Off the top of my head, I'd say around forty percent.",
    diagnosis: {
      type: 'linking',
      focus_phrase: 'off the top of my head',
      gloss_zh: '憑印象說',
      distractors_zh: ['深思熟慮', '從頭再來'],
      explanation_zh: '六個字連成一團唸，重音只落在 top 與 head，中間全部弱化。',
      practice_tip_zh: '先聽 top 和 head 兩個重音，中間不用逐字聽出來。',
    },
  },
  {
    slug: 'ballpark',
    sentence: "Can you give me a ballpark figure before the meeting?",
    diagnosis: {
      type: 'culture',
      focus_phrase: 'a ballpark figure',
      gloss_zh: '概略數字',
      // 「球場人數」是把 ballpark 照字面拆的結果。
      distractors_zh: ['球場人數', '最終定案'],
      explanation_zh: '源自棒球的比喻，指沒有精算過、大方向對就好的估計值。',
      practice_tip_zh: '記住它的反義是 exact figure，兩者常成對出現。',
    },
  },
];

/** 固定的假窗口，讓每張卡在畫面上看起來像真的難點窗口。 */
const WINDOW_SEC = 30;
const CONTEXT_PAD_SEC = 6;

/**
 * 產生示範 capture。
 *
 * `created_at` 用**當下時間**：`buildDeck` 不看它，但 UI 上的相對時間若顯示成
 * 1970 年會立刻穿幫。
 */
export function demoCaptures(now: Date = new Date()): Capture[] {
  const createdAt = now.toISOString();
  return SPECS.map((spec, i) => {
    const start = 300 + i * 180; // 5:00 起，每題間隔 3 分鐘
    return {
      id: `${DEMO_ID_PREFIX}${spec.slug}`,
      episode_id: `${DEMO_ID_PREFIX}episode`,
      window_start: start,
      window_end: start + WINDOW_SEC,
      context_start: Math.max(0, start - CONTEXT_PAD_SEC),
      context_end: start + WINDOW_SEC + CONTEXT_PAD_SEC,
      // 'weak' = 倒帶了。示範的是最常見的那一級，不是最強的那一級。
      strength: 'weak',
      // 'confirmed' = 已經說過「真的沒聽懂」。示範題直接跳過確認步驟。
      status: 'confirmed',
      transcript_text: spec.sentence,
      diagnosis: {
        type: spec.diagnosis.type,
        focus_phrase: spec.diagnosis.focus_phrase,
        explanation_zh: spec.diagnosis.explanation_zh ?? '',
        practice_tip_zh: spec.diagnosis.practice_tip_zh ?? '',
        gloss_zh: spec.diagnosis.gloss_zh,
        distractors_zh: [...spec.diagnosis.distractors_zh],
      },
      created_at: createdAt,
    } satisfies Capture;
  });
}

/**
 * 洗過牌的示範佇列。
 *
 * `buildDeck` 是**照順序取前 N 張**（`for…of` + `break`），所以不洗牌的話每次
 * demo 都會出同樣那三題。洗牌讓連續示範給不同人看時題目會換。
 */
export function shuffledDemoCaptures(
  now: Date = new Date(),
  random: () => number = Math.random,
): Capture[] {
  const list = demoCaptures(now);
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j] as Capture, list[i] as Capture];
  }
  return list;
}
