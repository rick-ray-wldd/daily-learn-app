/**
 * annotate — 標出逐字稿窗口裡「這位學習者可能卡住」的詞，附中文解釋。
 *
 *   in : { episodeId, segments: {id,text}[], weakTypes?: DifficultyType[] }
 *   out: { terms: Term[] }
 *
 * 為什麼用 LLM 而不是詞頻表：使用者要的是「點下去看解釋」。詞頻表只能告訴你
 * 一個詞罕見，說不出它在**這個句子裡**是什麼意思——一詞多義、片語動詞、專有
 * 名詞的背景，全都需要上下文。同一次呼叫就把兩件事一起解決，Haiku 4.5 標一個
 * 10 分鐘窗口約 $0.005。
 *
 * ⚠️ 這裡標的是**推測**，不是訊號。產品的核心主張仍然是「學習者按返回鍵才是
 * 他不懂的證據」（CONTEXT.md §1）。annotate 是閱讀輔助，不寫進 captures，也
 * 不參與 comprehension profile 的計算——只有 confirmed capture 才算數。
 *
 * `weakTypes` 是把已知的弱項回饋進來：學習者反覆在 linking 上卡住，就多標連音
 * 弱讀；已經穩定掌握 vocab 的人就少標生詞。這是「詞頻打底 + profile 微調」的
 * 微調那一半。
 */
import Anthropic from '@anthropic-ai/sdk';

import { consumeQuota, resolveCaller } from '../_shared/auth.ts';
import { json, preflight } from '../_shared/http.ts';

const MODEL = Deno.env.get('DIAGNOSE_MODEL') ?? 'claude-haiku-4-5';

/** 一次標一個窗口；比 diagnose 便宜，但仍要有上限。 */
const DAILY_LIMIT = 40;
/** 一個窗口最多標幾個詞——標太多等於沒標。 */
const MAX_TERMS = 12;
/** 送進 prompt 的字數上限，擋住異常大的 payload。 */
const MAX_CHARS = 12_000;

const TERM_TYPES = [
  'vocab',
  'linking',
  'speed',
  'grammar',
  'accent',
  'culture',
] as const;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return preflight();
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const caller = await resolveCaller(req);
  if (!caller) return json({ error: 'authentication required' }, 401);

  let body: { segments?: unknown; weakTypes?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const rawSegments = Array.isArray(body.segments) ? body.segments : [];
  const segments = rawSegments
    .map((s) => s as { id?: unknown; text?: unknown })
    .filter((s) => typeof s.id === 'number' && typeof s.text === 'string')
    .map((s) => ({ id: s.id as number, text: (s.text as string).trim() }))
    .filter((s) => s.text.length > 0);

  if (segments.length === 0) {
    return json({ error: 'segments is required' }, 400);
  }

  const weakTypes = Array.isArray(body.weakTypes)
    ? (body.weakTypes as unknown[])
        .filter((t): t is string => typeof t === 'string')
        .filter((t) => (TERM_TYPES as readonly string[]).includes(t))
    : [];

  const quota = await consumeQuota(caller.userId, 'annotate', DAILY_LIMIT);
  if (!quota.ok) {
    return json({ error: 'daily annotation limit reached', used: quota.used }, 429);
  }

  // 帶 segment id 給模型，讓它回報「哪一句裡的哪個詞」，client 就不必再做
  // 全文字串比對（同一個詞在窗口裡出現多次會對錯位置）。
  let transcript = segments.map((s) => `[${s.id}] ${s.text}`).join('\n');
  if (transcript.length > MAX_CHARS) transcript = transcript.slice(0, MAX_CHARS);

  const prompt = [
    '下面是一段 podcast 逐字稿，每行開頭的 [數字] 是句子編號。',
    '讀者是中文母語的英語學習者（中高級）。請挑出他們**最可能卡住**的詞或片語，',
    `最多 ${MAX_TERMS} 個，用 report_terms 工具回報。`,
    '',
    '挑選原則：',
    '- 優先：專有名詞（人名/機構/品牌/學術術語）、領域術語、片語動詞、慣用語、一詞多義中的少見義',
    '- 排除：中高級學習者已經熟悉的常用字',
    '- 同一個詞在窗口裡只報一次（挑最有代表性的那一句）',
    weakTypes.length > 0
      ? `- 這位學習者過去反覆卡在 ${weakTypes.join('、')}，這幾類多留意一些`
      : '',
    '',
    '每一項要有：',
    '- segment_id: 該詞所在句子的編號（必須是上面出現過的編號）',
    '- term: 原文詞/片語，**大小寫與拼寫需與逐字稿完全一致**（client 要用它定位）',
    '- type: vocab(生詞片語) / linking(連音弱讀) / speed(語速) / grammar(文法結構) / accent(口音) / culture(文化背景)',
    // 不指定字體的話模型會在簡繁之間飄，實測同一次回應裡「傷口癒合」和
    // 「医学术语」會並存。使用者在台灣，一律繁體。
    '- explanation_zh: **繁體中文（台灣用語）**解釋，含在這句話裡的實際意思，60 字以內。',
    '  絕對不要使用簡體字。',
    '',
    '逐字稿：',
    transcript,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const anthropic = new Anthropic({
      apiKey: Deno.env.get('ANTHROPIC_API_KEY') ?? '',
    });

    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      tools: [
        {
          name: 'report_terms',
          description:
            'Report the words and phrases most likely to block comprehension for a Chinese-speaking learner.',
          strict: true,
          input_schema: {
            type: 'object',
            properties: {
              terms: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    segment_id: { type: 'integer' },
                    term: { type: 'string' },
                    type: { type: 'string', enum: TERM_TYPES },
                    explanation_zh: { type: 'string' },
                  },
                  required: ['segment_id', 'term', 'type', 'explanation_zh'],
                  additionalProperties: false,
                },
              },
            },
            required: ['terms'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_terms' },
      messages: [{ role: 'user', content: prompt }],
    });

    const toolUse = message.content.find(
      (b) => b.type === 'tool_use' && b.name === 'report_terms',
    );
    const raw =
      toolUse?.type === 'tool_use'
        ? ((toolUse.input as { terms?: unknown }).terms ?? [])
        : [];

    // 模型不被盲信：只留下 segment_id 真的存在、且 term 真的出現在那句裡的項目。
    // 對不上的話 client 沒辦法把高亮畫在正確位置，寧可不標。
    const byId = new Map(segments.map((s) => [s.id, s.text]));
    const seen = new Set<string>();
    const terms = (Array.isArray(raw) ? raw : [])
      .map((t) => t as Record<string, unknown>)
      .filter((t) => {
        if (
          typeof t.segment_id !== 'number' ||
          typeof t.term !== 'string' ||
          typeof t.type !== 'string' ||
          typeof t.explanation_zh !== 'string'
        ) {
          return false;
        }
        const text = byId.get(t.segment_id);
        if (!text || !text.includes(t.term)) return false;
        const key = t.term.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_TERMS)
      .map((t) => ({
        segment_id: t.segment_id as number,
        term: t.term as string,
        type: t.type as string,
        explanation_zh: t.explanation_zh as string,
      }));

    return json({ terms });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return json({ error: 'upstream rate limited' }, 429);
    }
    // 標註是加值功能，失敗就不標，逐字稿照樣看得到。
    console.error('[annotate] request failed:', err);
    return json({ terms: [] });
  }
});
