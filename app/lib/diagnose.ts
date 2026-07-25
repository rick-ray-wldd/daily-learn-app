/**
 * Claude difficulty diagnosis — optional feature, active only when
 * EXPO_PUBLIC_ANTHROPIC_API_KEY is set.
 *
 * Sends the capture's sentence + surrounding context to the Claude API
 * (direct fetch to /v1/messages) and asks for a classification into the six
 * difficulty types of signal-design.md §5. Output is forced through a
 * strict-schema tool call (`strict: true` + tool_choice) so the response is
 * guaranteed-parseable JSON — no free-text parsing.
 *
 * Model: EXPO_PUBLIC_DIAGNOSE_MODEL, default claude-haiku-4-5-20251001
 * (fast + cheap: $1/$5 per MTok; one diagnosis is a few hundred tokens,
 * i.e. well under $0.01 per capture).
 *
 * ⚠️ SECURITY TODO (W3): EXPO_PUBLIC_* vars are baked into the JS bundle —
 * anyone with the app binary can extract this key. Acceptable ONLY for the
 * founder-dogfood phase. Move diagnosis to a Supabase Edge Function
 * (server-side key) before sharing builds with anyone else.
 */
import { Diagnosis, DiagnosisType } from './types';

const ANTHROPIC_API_KEY = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;
const MODEL =
  process.env.EXPO_PUBLIC_DIAGNOSE_MODEL || 'claude-haiku-4-5-20251001';
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

const DIAGNOSIS_TYPES: DiagnosisType[] = [
  'vocab',
  'linking',
  'speed',
  'grammar',
  'accent',
  'culture',
];

export function isDiagnosisConfigured(): boolean {
  return Boolean(ANTHROPIC_API_KEY);
}

export interface DiagnoseInput {
  /** The sentence(s) inside the capture window the learner replayed. */
  sentence: string;
  /** Surrounding sentences for context (linking/grammar need it). */
  context?: string;
}

/**
 * Diagnose why a learner likely failed to understand `sentence`.
 * Returns null when no key is configured, or on any failure (graceful —
 * the practice flow continues without a diagnosis card).
 */
export async function diagnoseCapture(
  input: DiagnoseInput,
): Promise<Diagnosis | null> {
  if (!ANTHROPIC_API_KEY) return null;

  const prompt = [
    '一位中文母語的英語學習者在聽 podcast 時重聽了下面這句話（多次倒帶＝很可能沒聽懂）。',
    '請診斷「最可能」的聽不懂原因（六選一），並用 report_diagnosis 工具回報：',
    '- type: vocab(生詞片語) / linking(連音弱讀) / speed(語速) / grammar(文法結構) / accent(口音) / culture(文化背景)',
    '- focus_phrase: 造成困難的那個原文詞/片語（保留英文原文）',
    '- explanation_zh: 中文解釋，60 字以內',
    '- practice_tip_zh: 中文練習建議，40 字以內',
    '',
    `聽不懂的句子：${input.sentence}`,
    input.context ? `前後文：${input.context}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        // Required for Expo Web (CORS); harmless on native. Dogfood-only —
        // see the security TODO at the top of this file.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
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
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn(`[diagnose] API ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }

    const json = (await res.json()) as {
      content?: { type: string; name?: string; input?: unknown }[];
    };
    const toolUse = json.content?.find(
      (b) => b.type === 'tool_use' && b.name === 'report_diagnosis',
    );
    return validateDiagnosis(toolUse?.input);
  } catch (err) {
    console.warn('[diagnose] request failed:', err);
    return null;
  }
}

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

/** UI labels for the six difficulty types. */
export const DIAGNOSIS_LABELS_ZH: Record<DiagnosisType, string> = {
  vocab: '生詞片語',
  linking: '連音弱讀',
  speed: '語速',
  grammar: '文法結構',
  accent: '口音',
  culture: '文化背景',
};
