/**
 * Simplified SM-2 spaced repetition.
 *
 * item = { capture_id, ease (2.5 start), interval_days, due_date, reps }
 * Grades:
 *   again → interval 0、ease −0.2（下限 1.3）（今天再來一次）
 *   good  → interval = max(1, round(interval × ease))
 *   easy  → interval = max(1, round(max(interval,1) × ease × 1.6)), ease +0.1
 *
 * Pure functions only — persistence lives in lib/store.ts
 * (`upsertSrsItem`), so these are trivially unit-testable.
 */
import { SrsItem } from './types';

export type SrsGrade = 'again' | 'good' | 'easy';

const START_EASE = 2.5;
const EASY_BONUS = 1.6;
const EASY_EASE_DELTA = 0.1;
const AGAIN_EASE_DELTA = 0.2;
const MIN_EASE = 1.3;

/** Local-timezone YYYY-MM-DD. */
export function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function todayStr(now: Date = new Date()): string {
  return toDateStr(now);
}

export function addDaysStr(days: number, from: Date = new Date()): string {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
}

/** Fresh item: due today so it can be graded in the same session. */
export function newSrsItem(captureId: string, now: Date = new Date()): SrsItem {
  return {
    capture_id: captureId,
    ease: START_EASE,
    interval_days: 0,
    due_date: toDateStr(now),
    reps: 0,
  };
}

/** Apply a grade; returns a NEW item (input untouched). */
export function gradeSrsItem(
  item: SrsItem,
  grade: SrsGrade,
  now: Date = new Date(),
): SrsItem {
  const reps = item.reps + 1;
  switch (grade) {
    case 'again':
      return {
        ...item,
        reps,
        ease: Math.max(MIN_EASE, Math.round((item.ease - AGAIN_EASE_DELTA) * 100) / 100),
        interval_days: 0,
        due_date: toDateStr(now), // 今天再來
      };
    case 'good': {
      const interval = Math.max(1, Math.round(item.interval_days * item.ease));
      return {
        ...item,
        reps,
        interval_days: interval,
        due_date: addDaysStr(interval, now),
      };
    }
    case 'easy': {
      const base = Math.max(1, item.interval_days);
      const interval = Math.max(
        1,
        Math.round(base * item.ease * EASY_BONUS),
      );
      return {
        ...item,
        reps,
        ease: Math.round((item.ease + EASY_EASE_DELTA) * 100) / 100,
        interval_days: interval,
        due_date: addDaysStr(interval, now),
      };
    }
  }
}

/** Due today or overdue (string compare works for YYYY-MM-DD). */
export function isDue(item: SrsItem, now: Date = new Date()): boolean {
  return item.due_date <= toDateStr(now);
}

/** Items becoming due tomorrow (for the「明日到期」done-screen stat). */
export function isDueTomorrow(item: SrsItem, now: Date = new Date()): boolean {
  const today = toDateStr(now);
  const tomorrow = addDaysStr(1, now);
  return item.due_date > today && item.due_date <= tomorrow;
}
