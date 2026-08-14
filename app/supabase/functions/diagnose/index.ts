/**
 * diagnose — Claude difficulty diagnosis, server side (ADR-0008).
 *
 * Moves the Anthropic key off the client. The request/response contract is
 * deliberately identical to what `app/lib/diagnose.ts` used to build inline, so
 * the swap happens entirely behind the existing seam:
 *
 *   in : { sentence: string, context?: string }
 *   out: { diagnosis: Diagnosis | null }
 *
 * `null` means "no diagnosis this time" — the practice flow degrades to a card
 * without a diagnosis rather than failing, same as before.
 *
 * Output is forced through a strict-schema tool call (`strict: true` +
 * `tool_choice`) so the response is guaranteed-parseable JSON.
 *
 * Model: DIAGNOSE_MODEL secret, default claude-haiku-4-5 ($1/$5 per MTok — one
 * diagnosis is a few hundred tokens, well under $0.01 per capture). Note Haiku
 * 4.5 does not accept the `effort` parameter; don't add one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 出題欄位（`gloss_zh` / `distractors_zh`）走**第二條、完全獨立的路**
 * ─────────────────────────────────────────────────────────────────────────────
 * 上面那 4 個 key 是這支函式的本業，任何出題相關的檢查都**不准**影響它們：
 * 出題資料不合格時就只回那 4 個 key，與線上既有的 diagnosis 逐位元組相容。
 *
 * 出題欄位要通過三道閘，缺一不可（順序＝由便宜到昂貴）：
 *   ① 型別／字數／標點／單一詞（`pickQuizFields`，純字串檢查）
 *   ② 字面重疊（`overlaps`）
 *   ③ **盲測複核**（`verifyQuizOptions`，第二次 API 呼叫）——把三個選項洗牌後交給
 *      模型逐一判斷「能不能當作這個片語的意思」，**不告訴它哪一個是預定的正解**。
 *      只有「恰好一個 true 且那個就是正解」才採用。
 *
 * ③ 為什麼值得多花一次呼叫：①② 都是字面檢查，擋不掉語義重疊。實測
 * （focus_phrase = "reluctant"）正解「不願意」配上干擾項「猶豫的」，三個字串兩兩
 * 無子字串關係，①② 全部放行——但「猶豫的」對這句話也講得通。使用者選它會被判錯，
 * 而答錯**會寫 `gradeSrsItem(item, 'again')`**（`lib/notifications.ts:593`），
 * 我們就拿到一筆捏造的「他不會這個詞」。這個 app 全部的論點是「這些數字是真的」，
 * 所以寧可多花 $0.002、寧可少一張卡，也不要多一筆假資料。
 */
import Anthropic from '@anthropic-ai/sdk';

import { consumeQuota, resolveCaller } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';

const MODEL = Deno.env.get('DIAGNOSE_MODEL') ?? 'claude-haiku-4-5';

/** Per-user daily cap. A real session produces well under this. */
const DAILY_LIMIT = 120;

const DIAGNOSIS_TYPES = [
  'vocab',
  'linking',
  'speed',
  'grammar',
  'accent',
  'culture',
] as const;

type DiagnosisType = (typeof DIAGNOSIS_TYPES)[number];

interface Diagnosis {
  type: DiagnosisType;
  focus_phrase: string;
  explanation_zh: string;
  practice_tip_zh: string;
  /**
   * 這兩欄是**選用**的，而且是刻意的：線上既有的 diagnosis 只有上面 4 個 key，
   * 把它們變成必填等於讓舊資料整筆失效。品質不夠時 server 端直接不 emit，
   * 回傳物件就與今天逐位元組相同。形狀對應 app/lib/liveActivity.ts 的 DiagnosisGloss。
   */
  gloss_zh?: string;
  distractors_zh?: string[];
}

/** 選項字數上限。來源：app/lib/liveActivity.ts:57 OPTION_LABEL_MAX_CHARS。兩邊漂移時看這行。 */
const OPTION_LABEL_MAX_CHARS = 8;
/** = OPTIONS_PER_CARD - 1（liveActivity.ts:53）。存活數不到 2 個，client 一定丟掉整張卡。 */
const REQUIRED_DISTRACTORS = 2;

/**
 * 選項裡不准有標點。prompt 早就寫了「不要標點符號」，但**實測照樣會回**
 * 「終止、放棄」（focus_phrase = "pull the plug on"）——它只有 5 個 code point，
 * 長度檢查放行，可是那是**兩個義項**串在一起：只要有一個干擾項碰到其中任一個義項，
 * 那張卡就有兩個正解。所以把 prompt 的那條規則變成機械檢查。
 */
const PUNCTUATION_RE = /[，、。；：！？,.;:!?／/｜|「」『』（）()《》〈〉…～~—–]/u;

/**
 * 一次只出一個詞。線上唯一那筆 diagnosis 的 focus_phrase 是
 * `"pharmacology, pharmacologic substance"`：兩個詞塞不進 8 字的 gloss，模型只能挑
 * 一個，而**另一個詞的正確譯法**很可能被寫進干擾項——四個選項裡有兩個都對。
 * 多詞時只是不出題（4 個 key 的 diagnosis 照常回傳），不是整筆作廢。
 */
const MULTI_TERM_RE = /[,，、;；/／]|\s+or\s+/i;

/** 與 client 同一種計數法：code point，中文一字算一個。 */
const charCount = (s: string): number => Array.from(s).length;

/**
 * 字面相等只是最弱的一層防線。「藥物學」與「藥物學名詞」兩個都對、都會通過
 * `value === gloss`，那張卡使用者答什麼都是錯的，而答錯會寫 gradeSrsItem 'again'
 * ——我們會拿到一筆捏造的「他不會這個」。所以連互相包含也擋。
 *
 * ⚠️ **它只看字面，擋不到語義。**「不願意」／「猶豫的」、「藥物性物質」／「生物製劑」、
 * 「藥物學」／「药物学」三種情形都會原封不動通過這裡。語義那一層是
 * `verifyQuizOptions`，不是這支——不要在別處宣稱「server 端已保證不重疊」。
 */
const overlaps = (a: string, b: string): boolean =>
  a === b || a.includes(b) || b.includes(a);

function pickGloss(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  // 超長一律 **丟棄，不准截斷**：截過的字串照樣通過 client 的長度檢查
  // （檢查在洗牌之前跑），但語意已經壞掉。
  if (!value || charCount(value) > OPTION_LABEL_MAX_CHARS) return undefined;
  if (PUNCTUATION_RE.test(value)) return undefined;
  return value;
}

function pickDistractors(raw: unknown, gloss: string): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (!value || charCount(value) > OPTION_LABEL_MAX_CHARS) continue;
    if (PUNCTUATION_RE.test(value)) continue;
    if (overlaps(value, gloss)) continue;
    if (out.some((d) => overlaps(d, value))) continue;
    out.push(value);
    if (out.length === REQUIRED_DISTRACTORS) break;
  }
  return out.length === REQUIRED_DISTRACTORS ? out : undefined;
}

/** Fisher-Yates。複核時要洗牌，才不會讓「正解永遠在第 1 格」變成可猜的訊號。 */
function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

const anthropic = new Anthropic({
  apiKey: Deno.env.get('ANTHROPIC_API_KEY') ?? '',
});

function buildPrompt(sentence: string, context?: string): string {
  return [
    '一位中文母語的英語學習者在聽 podcast 時重聽了下面這句話（多次倒帶＝很可能沒聽懂）。',
    '請診斷「最可能」的聽不懂原因（六選一），並用 report_diagnosis 工具回報：',
    '- type: vocab(生詞片語) / linking(連音弱讀) / speed(語速) / grammar(文法結構) / accent(口音) / culture(文化背景)',
    '- focus_phrase: 造成困難的那個原文詞/片語（保留英文原文）',
    // 多詞的 focus_phrase 讓「8 字簡義」失去定義：模型只能挑一個詞回答，另一個詞的
    // 正確譯法就可能落到干擾項裡。所以 vocab（唯一會出題的那一類）限定單一詞。
    '  ⚠️ type 是 vocab 時，focus_phrase **只給一個**詞或片語：不要用逗號、頓號、斜線或 or 列出兩個以上',
    // 不指定字體模型會在簡繁之間飄（annotate 實測同一次回應裡簡繁並存）。
    '- explanation_zh: **繁體中文（台灣用語）**解釋，60 字以內。絕對不要用簡體字',
    '- practice_tip_zh: **繁體中文（台灣用語）**練習建議，40 字以內。絕對不要用簡體字',
    // ↓↓↓ 本輪新增：鎖定畫面/通知的三選一測驗要用的正解與干擾項。
    //    長度與數量都**不可能**用 strict schema 強制（strict 不支援 maxLength/minItems），
    //    所以這裡的數字必須寫死在 prompt，並且在 validateDiagnosis 再擋一次。
    '- gloss_zh: focus_phrase **在這句話裡**的中文簡義，**8 個中文字以內**。繁體中文（台灣用語），只寫詞義本身：不要標點符號、不要引號括號、不要解釋句，要一個名詞或名詞片語',
    '  一詞多義時取**這句話用到的那個義項**，不是字典第一個義項',
    // 「不是 vocab 就回空字串」這條在 pickQuizFields 也擋一次：prompt 是唯一那層時
    // 實測會漏（type: linking 仍回了 gloss「神經元按順序放電」）。
    '  ⚠️ 它不是 explanation_zh 的縮寫。如果 type 不是 vocab（連音、語速、口音等），或這個片語沒辦法用 8 字以內的中文名詞說清楚，就回傳空字串 ""，不要硬掰',
    '  ⚠️ 只寫**一個**義項。「終止、放棄」這種用頓號串兩個義項的寫法一律不採用——它等於同時公布兩個正解',
    '- distractors_zh: **3 個**干擾項，要當三選一測驗裡的錯誤選項。以下每一條都要滿足：',
    '  ① 每一個都是**另一個具體英文詞**的中文意思——先在心裡想好那個英文詞，再寫下它的中文意思。不要寫抽象、含糊或臨時造的詞',
    '  ② 與 gloss_zh **語義上明確不同**：不可以是它的同義詞、近義詞、上位詞、下位詞、換句話說，也不可以只是加減修飾語。驗收標準：一個懂中文的人看到這三個選項，必須能毫不猶豫指出只有一個是對的',
    '  ③ 與 gloss_zh **同一個難度層級**：同一個主題領域、同樣的詞性與語體（都是名詞，不是解釋句）、字數與 gloss_zh 相差不超過 2 個字。太簡單會被猜到，太離譜等於送分',
    '  ④ 每個 8 個中文字以內，繁體中文（台灣用語），不要標點符號，三個彼此也要互不相同',
    '  例（focus_phrase = "pharmacology"）：gloss_zh 是「藥物學」。好的干擾項＝「地質學」「會計學」「氣象學」（各自是 geology / accounting / meteorology 的意思，明確不同、同為學科名詞、字數相近）。壞的干擾項＝「藥理學」「藥學」（與正解同義，等於四個選項裡有兩個都對，使用者答什麼都會被記成答錯）',
    'gloss_zh 是空字串時，distractors_zh 就回傳空陣列 []。寧可不給，也不要給一組會讓使用者無法作答的選項。',
    // 明講後面有一道盲測複核，可以讓模型在這一步就自己砍掉近義詞（省掉一次浪費的複核）。
    '⚠️ 這組選項接下來會交給**另一個看不到你意圖的模型**逐一判斷「能不能當作這個片語的意思」。只要它認為有兩個以上講得通，整組就會被丟掉。所以請用「懂中文的人會毫不猶豫指出只有一個對」當標準，不要交出近義詞、簡繁異寫或換句話說。',
    '',
    `聽不懂的句子：${sentence}`,
    context ? `前後文：${context}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Same shape check the client used to run — the model is not trusted blindly. */
function validateDiagnosis(input: unknown): Diagnosis | null {
  if (!input || typeof input !== 'object') return null;
  const d = input as Record<string, unknown>;
  if (
    typeof d.type !== 'string' ||
    !DIAGNOSIS_TYPES.includes(d.type as DiagnosisType) ||
    typeof d.focus_phrase !== 'string' ||
    typeof d.explanation_zh !== 'string' ||
    typeof d.practice_tip_zh !== 'string'
  ) {
    console.warn('[diagnose] response failed validation:', d);
    return null;
  }
  // **逐欄位重建**，不 spread：模型回的 gloss_zh / distractors_zh 一律不從這裡出去，
  // 它們要另外走 pickQuizFields + verifyQuizOptions 兩道閘才准掛回這個物件上。
  return {
    type: d.type as DiagnosisType,
    focus_phrase: d.focus_phrase,
    explanation_zh: d.explanation_zh,
    practice_tip_zh: d.practice_tip_zh,
  };
}

/**
 * 出題欄位的**純字串**閘門。任何一條不過就回 null——出題資料不合格從來不影響
 * 上面那 4 個 key。
 *
 * 為什麼是 all-or-nothing（有 gloss 沒干擾項也回 null，不再單獨 emit gloss）：
 * client 端重新診斷的門檻是「**沒有** gloss_zh」（`screens/Practice.tsx` 的
 * `needsDiagnosis`）。半成品（有正解、沒干擾項）會被那道門當成「已經有了」，於是
 * **永久**卡在 'not-enough-distractors'。要嘛給一張出得了題的，要嘛什麼都不給、
 * 讓它下次還有機會被重新診斷。診斷力改由這裡的 console.warn 提供。
 */
function pickQuizFields(
  d: Record<string, unknown>,
  diagnosis: Diagnosis,
): { gloss: string; distractors: string[] } | null {
  // ① 只有 vocab 出題。prompt 已經寫了這條，但 prompt 是唯一那層時實測會漏
  //    （type: linking 仍回了 gloss「神經元按順序放電」）。而且那種卡問的是整個
  //    片語的翻譯、測不到連音那個真正的斷點——答錯照樣寫 'again'，等於捏造資料。
  if (diagnosis.type !== 'vocab') return null;

  // ② focus_phrase 必須是單一詞（見 MULTI_TERM_RE）。
  if (MULTI_TERM_RE.test(diagnosis.focus_phrase)) {
    console.warn('[diagnose] focus_phrase is multi-term, no quiz:', diagnosis.focus_phrase);
    return null;
  }

  const gloss = pickGloss(d.gloss_zh);
  if (!gloss) return null;

  const distractors = pickDistractors(d.distractors_zh, gloss);
  if (!distractors) {
    console.warn('[diagnose] gloss passed but distractors did not:', d.distractors_zh);
    return null;
  }
  return { gloss, distractors };
}

/**
 * 盲測複核：把三個選項洗牌後交給模型逐一判斷「能不能當作 focus_phrase 的意思」，
 * **不告訴它哪一個是預定的正解**。只有「恰好一個 true 且那個就是正解」才回 true。
 *
 * 這一道擋的是 `overlaps()` 擋不到的**語義**重疊——同義詞、上位詞、下位詞、換句話說、
 * 以及同一個詞的簡繁／異體寫法（「藥物學」與「药物学」逐字元完全不同，字面檢查必然
 * 放行）。實測擋下的例子：focus_phrase = "reluctant"，正解「不願意」配干擾項「猶豫的」。
 *
 * **一律 fail closed**：複核出錯、超時、格式不對，全部當成沒通過。少一張卡的代價是
 * 使用者今天少一次曝光；多一張兩個正解的卡，代價是一筆捏造的「他不會這個」。
 */
async function verifyQuizOptions(args: {
  sentence: string;
  focusPhrase: string;
  gloss: string;
  distractors: string[];
}): Promise<boolean> {
  const labels = shuffle([args.gloss, ...args.distractors]);
  const correctSlot = labels.indexOf(args.gloss);
  if (correctSlot < 0 || labels.length !== 3) return false;

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      // 只回三個 boolean，256 綽綽有餘。
      max_tokens: 256,
      tools: [
        {
          name: 'report_option_check',
          description:
            'Judge independently whether each Chinese option can serve as the meaning of the English phrase in this sentence.',
          strict: true,
          input_schema: {
            type: 'object',
            properties: {
              option_1_ok: { type: 'boolean' },
              option_2_ok: { type: 'boolean' },
              option_3_ok: { type: 'boolean' },
            },
            required: ['option_1_ok', 'option_2_ok', 'option_3_ok'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_option_check' },
      messages: [
        {
          role: 'user',
          content: [
            '下面是一句英文，以及其中的一個片語。三個中文選項，請**各自獨立**判斷每一個能不能當作這個片語在這句話裡的中文意思。',
            '判準（寬鬆那一側）：語意正確或很接近就填 true——同義詞、近義詞、上位詞、下位詞、換句話說、只差一個修飾語、同一個詞的簡繁或異體寫法，全部算 true。意思**明確不同**才填 false。',
            '⚠️ 這三個選項本來應該只有一個是對的。你的工作就是把「其實也講得通」的那些抓出來，不要為了讓答案漂亮而遷就。',
            '',
            `英文句子：${args.sentence}`,
            `片語：${args.focusPhrase}`,
            `選項 1：${labels[0]}`,
            `選項 2：${labels[1]}`,
            `選項 3：${labels[2]}`,
          ].join('\n'),
        },
      ],
    });

    const toolUse = message.content.find(
      (block) => block.type === 'tool_use' && block.name === 'report_option_check',
    );
    if (toolUse?.type !== 'tool_use') return false;

    const v = toolUse.input as Record<string, unknown>;
    const verdicts = [v.option_1_ok, v.option_2_ok, v.option_3_ok];
    if (verdicts.some((x) => typeof x !== 'boolean')) return false;

    const accepted = verdicts.filter(Boolean).length;
    const ok = verdicts[correctSlot] === true && accepted === 1;
    if (!ok) {
      // 這行是唯一看得出「為什麼今天卡變少」的地方，不要拿掉。
      console.warn(
        '[diagnose] quiz options rejected by blind check:',
        JSON.stringify({ focus: args.focusPhrase, labels, correctSlot, verdicts }),
      );
    }
    return ok;
  } catch (err) {
    console.warn('[diagnose] blind option check failed, dropping quiz fields:', err);
    return false;
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const caller = await resolveCaller(req);
  if (!caller) {
    // The anon key alone lands here: it is a valid JWT but carries no user.
    return json({ error: 'authentication required' }, 401);
  }

  const quota = await consumeQuota(caller.userId, 'diagnose', DAILY_LIMIT);
  if (!quota.ok) {
    return json(
      { error: 'daily diagnosis limit reached', used: quota.used },
      429,
    );
  }

  let body: { sentence?: unknown; context?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const sentence = typeof body.sentence === 'string' ? body.sentence.trim() : '';
  const context = typeof body.context === 'string' ? body.context : undefined;
  if (!sentence) return json({ error: 'sentence is required' }, 400);

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      // 512 → 1024 是**迴歸防護**，不是新功能的需求：模型實測會把 explanation_zh
      // 寫到 88 字（prompt 寫 60），再多一個 gloss + 3 個干擾項，一旦撞到上限
      // tool_use block 會被截斷 → 整個 diagnosis 解析失敗 → 連原本那 4 個欄位
      // 一起丟掉，等於用新功能弄壞舊功能。成本影響可忽略（Haiku 4.5 $1/$5 per MTok）。
      max_tokens: 1024,
      tools: [
        {
          name: 'report_diagnosis',
          description:
            'Report the single most likely reason the learner failed to understand the sentence.',
          strict: true,
          input_schema: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: DIAGNOSIS_TYPES },
              focus_phrase: { type: 'string' },
              explanation_zh: { type: 'string' },
              practice_tip_zh: { type: 'string' },
              // strict 模式不支援 maxLength / minItems / maxItems（會被 API 400 掉），
              // 所以「8 字以內」「恰好 3 個」只能靠 prompt + pickQuizFields。
              // 這兩欄照本專案慣例列進 required（annotate/index.ts:139 同）：
              // 品質不夠時由模型回 "" / []，再由 pickQuizFields + verifyQuizOptions
              // 決定不 emit，回傳物件就只剩原本 4 個 key，對既有消費端逐位元組相容。
              gloss_zh: { type: 'string' },
              distractors_zh: { type: 'array', items: { type: 'string' } },
            },
            required: [
              'type',
              'focus_phrase',
              'explanation_zh',
              'practice_tip_zh',
              'gloss_zh',
              'distractors_zh',
            ],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_diagnosis' },
      messages: [{ role: 'user', content: buildPrompt(sentence, context) }],
    });

    // 截斷是安靜的：tool_use 被切斷 → 解析失敗 → 回 null，看起來像「這次沒診斷」。
    // 沒有這行 log 就查不出是撞到上限還是模型不肯回。
    if (message.stop_reason === 'max_tokens') {
      console.warn('[diagnose] hit max_tokens; diagnosis may be truncated');
    }

    const toolUse = message.content.find(
      (block) => block.type === 'tool_use' && block.name === 'report_diagnosis',
    );
    const raw = toolUse?.type === 'tool_use' ? toolUse.input : undefined;

    const diagnosis = validateDiagnosis(raw);
    // 出題欄位掛回去的**唯一**入口。三道閘任何一道不過，回傳的就是原本那 4 個 key，
    // 與線上既有的 diagnosis 逐位元組相同。
    if (diagnosis && raw && typeof raw === 'object') {
      const quiz = pickQuizFields(raw as Record<string, unknown>, diagnosis);
      if (
        quiz &&
        (await verifyQuizOptions({
          sentence,
          focusPhrase: diagnosis.focus_phrase,
          gloss: quiz.gloss,
          distractors: quiz.distractors,
        }))
      ) {
        diagnosis.gloss_zh = quiz.gloss;
        diagnosis.distractors_zh = quiz.distractors;
      }
    }

    return json({ diagnosis });
  } catch (err) {
    // Graceful, like the old client path: no diagnosis rather than an error
    // card — except for rate limits, which the client should back off on.
    if (err instanceof Anthropic.RateLimitError) {
      return json({ error: 'upstream rate limited' }, 429);
    }
    console.error('[diagnose] request failed:', err);
    return json({ diagnosis: null });
  }
});
