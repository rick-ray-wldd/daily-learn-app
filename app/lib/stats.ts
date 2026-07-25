/**
 * Streak ＋ 弱點統計 — 全部純函式，只讀 store 現有結構
 * （不加新表、不加新 AsyncStorage key）。
 */
import { toDateStr } from './srs';
import { Capture, DiagnosisType, PracticeRecord } from './types';

/**
 * Streak = 連續「有練習」(items_completed>0) 的天數。
 * 同日多筆 record 用 Set 去重；今天還沒練不斷 streak（從昨天起算）。
 */
export function computeStreak(log: PracticeRecord[], now: Date = new Date()): number {
  const days = new Set(log.filter((r) => r.items_completed > 0).map((r) => r.date));
  const cursor = new Date(now);
  if (!days.has(toDateStr(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(toDateStr(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export interface WeaknessStats {
  totalCaptures: number; // 累計 capture 數（所有狀態）
  confirmRate: number | null; // (confirmed+practiced)/(confirmed+practiced+dismissed)；分母 0 → null
  diagnosedCount: number; // 有 diagnosis 的 capture 數
  typeCounts: Partial<Record<DiagnosisType, number>>;
  topType: { type: DiagnosisType; count: number; pct: number } | null; // 最大宗難點類型
}

export function computeWeaknessStats(captures: Capture[]): WeaknessStats {
  const judged = captures.filter(
    (c) => c.status === 'confirmed' || c.status === 'practiced' || c.status === 'dismissed',
  );
  const confirmed = judged.filter((c) => c.status !== 'dismissed').length;
  const typeCounts: Partial<Record<DiagnosisType, number>> = {};
  let diagnosedCount = 0;
  for (const c of captures) {
    if (!c.diagnosis) continue;
    diagnosedCount += 1;
    typeCounts[c.diagnosis.type] = (typeCounts[c.diagnosis.type] ?? 0) + 1;
  }
  let topType: WeaknessStats['topType'] = null;
  for (const [type, count] of Object.entries(typeCounts) as [DiagnosisType, number][]) {
    if (!topType || count > topType.count) {
      topType = { type, count, pct: Math.round((count / diagnosedCount) * 100) };
    }
  }
  return {
    totalCaptures: captures.length,
    confirmRate: judged.length > 0 ? confirmed / judged.length : null,
    diagnosedCount,
    typeCounts,
    topType,
  };
}
