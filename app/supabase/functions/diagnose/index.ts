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
    // 不指定字體模型會在簡繁之間飄（annotate 實測同一次回應裡簡繁並存）。
    '- explanation_zh: **繁體中文（台灣用語）**解釋，60 字以內。絕對不要用簡體字',
    '- practice_tip_zh: **繁體中文（台灣用語）**練習建議，40 字以內。絕對不要用簡體字',
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
  return {
    type: d.type as DiagnosisType,
    focus_phrase: d.focus_phrase,
    explanation_zh: d.explanation_zh,
    practice_tip_zh: d.practice_tip_zh,
  };
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
      max_tokens: 512,
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
            },
            required: [
              'type',
              'focus_phrase',
              'explanation_zh',
              'practice_tip_zh',
            ],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'report_diagnosis' },
      messages: [{ role: 'user', content: buildPrompt(sentence, context) }],
    });

    const toolUse = message.content.find(
      (block) => block.type === 'tool_use' && block.name === 'report_diagnosis',
    );

    return json({
      diagnosis: validateDiagnosis(
        toolUse?.type === 'tool_use' ? toolUse.input : undefined,
      ),
    });
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
