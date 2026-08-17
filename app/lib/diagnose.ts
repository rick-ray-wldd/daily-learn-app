/**
 * Claude difficulty diagnosis — optional feature, active whenever Supabase is
 * configured.
 *
 * Sends the capture's sentence + surrounding context to the `diagnose` Edge
 * Function, which holds the Anthropic key server-side and forces the answer
 * through a strict-schema tool call (ADR-0008). The client no longer carries a
 * provider key of any kind.
 *
 * The exported surface is unchanged from the dogfood version — `diagnoseCapture`
 * still resolves to a `Diagnosis` or null, so the practice flow is untouched by
 * the migration.
 */
import { ensureSession, supabase } from './supabase';
import { Diagnosis, DiagnosisType } from './types';
import { t } from './i18n';

const DIAGNOSIS_TYPES: DiagnosisType[] = [
  'vocab',
  'linking',
  'speed',
  'grammar',
  'accent',
  'culture',
];

export function isDiagnosisConfigured(): boolean {
  return supabase !== null;
}

export interface DiagnoseInput {
  /** The sentence(s) inside the capture window the learner replayed. */
  sentence: string;
  /** Surrounding sentences for context (linking/grammar need it). */
  context?: string;
}

/**
 * Diagnose why a learner likely failed to understand `sentence`.
 * Returns null when Supabase isn't configured, when there is no session, or on
 * any failure (graceful — the practice flow continues without a diagnosis card).
 */
export async function diagnoseCapture(
  input: DiagnoseInput,
): Promise<Diagnosis | null> {
  if (!supabase) return null;

  // The function rejects callers without a real user, so make sure the
  // anonymous session exists before spending a round trip.
  const userId = await ensureSession();
  if (!userId) return null;

  try {
    const { data, error } = await supabase.functions.invoke('diagnose', {
      body: { sentence: input.sentence, context: input.context },
    });

    if (error) {
      console.warn('[diagnose] edge function failed:', error.message);
      return null;
    }

    return validateDiagnosis((data as { diagnosis?: unknown } | null)?.diagnosis);
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
  const out: Diagnosis = {
    type: d.type as DiagnosisType,
    focus_phrase: d.focus_phrase,
    explanation_zh: d.explanation_zh,
    practice_tip_zh: d.practice_tip_zh,
  };

  // 這兩欄一律當 optional 讀：舊 capture 沒有它們，**缺 ≠ 失敗**。所以它們絕不能
  // 出現在上面那段 reject 條件裡——加進去等於讓線上既有的 diagnosis 整筆作廢。
  //
  // 這裡**刻意只做型別安全 + trim**，不重做 8 字上限／去重／難度檢查：那些守門在
  // `liveActivity.ts` 的 `buildCard`（唯一的規格來源）與 Edge Function 的 server
  // validator 裡，在這裡再抄一份只會隨時間漂移，然後兩邊對同一張卡給出不同判決。
  //
  // 空字串與空陣列**不寫進物件**：模型在品質不夠時就是回 `""` / `[]`（見 diagnose
  // 的 prompt），把它們留下來會讓下游分不清「還沒生成」和「生成了但是空的」。
  if (typeof d.gloss_zh === 'string') {
    const gloss = d.gloss_zh.trim();
    if (gloss) out.gloss_zh = gloss;
  }
  if (Array.isArray(d.distractors_zh)) {
    const list = d.distractors_zh
      .filter((x): x is string => typeof x === 'string')
      .map((x) => x.trim())
      .filter(Boolean);
    if (list.length > 0) out.distractors_zh = list;
  }
  return out;
}

/**
 * 六類難點的介面標籤。
 *
 * **是函式不是常數**，而且這個差別很要緊：常數在 import 時求值一次，
 * 介面語言切換之後它仍然是啟動當下那一種——而它印在練習卡與詞卡上，
 * 使用者會看到一個英文畫面裡混著一個中文分類標籤，而且沒有任何錯誤訊息。
 */
export function diagnosisLabel(type: DiagnosisType): string {
  return t(`diag.${type}`);
}
