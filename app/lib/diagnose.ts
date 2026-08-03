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
