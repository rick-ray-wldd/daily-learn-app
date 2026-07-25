/**
 * Capture engine — turns raw replay events into graded captures.
 *
 * Implements signal-design.md §2 (訊號強度分層), §3 (過濾留給練習) and
 * §4 (擷取窗口演算法), incrementally: every replay event is merged into the
 * existing capture set the moment it arrives.
 *
 * Rules implemented:
 *  - Window for a rewind at position T   → [T-15, T], context padded ±6s.
 *  - Same-segment rewind ×2 (windows overlap)
 *                                        → strength 'strong',
 *                                          window = intersection (§4 locks
 *                                          onto the single sentence); if the
 *                                          intersection is <3s（幾乎鎖不到
 *                                          完整句）改保留 union，仍升級。
 *  - Rewind then slower playback ≤10s    → strength 'strong'.
 *  - Single rewind                       → strength 'weak' (may be a
 *                                          distraction; the practice screen's
 *                                          confirm step filters it, §3).
 *  - Rewind ≤3s after a rewind, jumping  → treated as "looking for a
 *    to an even earlier position            passage": merged (window union)
 *                                          WITHOUT upgrading strength.
 *
 * No confirmation UI ever appears during listening — §3's cardinal rule.
 */
import * as Crypto from 'expo-crypto';

import { toDateStr, todayStr } from './srs';
import { getCaptures, upsertCapture, updateCapture } from './store';
import { Capture } from './types';

const WINDOW_SECONDS = 15;
const CONTEXT_PAD_SECONDS = 6;
/** A rewind this soon after the previous one, to an earlier point, is "seeking". */
const SECTION_SEEK_WINDOW_MS = 3_000;
/** Slowing down within this window after a rewind upgrades the capture. */
const SLOWDOWN_UPGRADE_WINDOW_MS = 10_000;
/** 交集窄於此值時鎖不到完整句子 → 改保留 union（仍升級 strong）。 */
const MIN_INTERSECTION_SECONDS = 3;

export interface ReplayInput {
  episodeId: string;
  /** Position the user rewound FROM (= T, end of the difficulty window). */
  fromPos: number;
  /** Position the user rewound TO. */
  toPos: number;
  /** Episode duration, used to clamp context_end. Optional. */
  durationSec?: number;
}

interface LastRewind {
  captureId: string;
  episodeId: string;
  toPos: number;
  atMs: number;
}

/** In-memory only — merge heuristics matter within a listening session. */
let lastRewind: LastRewind | null = null;

/** RFC4122 v4 UUID — expo-crypto，密碼學安全（Expo Go 內建支援）。 */
export function uuidv4(): string {
  return Crypto.randomUUID();
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 嚴格重疊：相切（aEnd === bStart）不算，避免合併出零寬交集窗口。 */
function windowsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function withContext(
  capture: Capture,
  durationSec?: number,
): Capture {
  const contextStart = Math.max(0, capture.window_start - CONTEXT_PAD_SECONDS);
  let contextEnd = capture.window_end + CONTEXT_PAD_SECONDS;
  if (durationSec && durationSec > 0) {
    contextEnd = Math.min(contextEnd, durationSec);
  }
  return {
    ...capture,
    context_start: round1(contextStart),
    context_end: round1(contextEnd),
  };
}

/**
 * Feed one replay event (any backward seek: Back-15s button, backward scrub,
 * future headphone/lockscreen sources) into the engine. Merges into an
 * existing overlapping capture or creates a new weak one, persists via the
 * store, and returns the resulting capture.
 */
export function ingestReplayEvent(input: ReplayInput): Capture {
  const now = Date.now();
  const windowEnd = round1(Math.max(0, input.fromPos));
  const windowStart = round1(Math.max(0, windowEnd - WINDOW_SECONDS));

  // Only merge into TODAY's still-pending captures of the same episode —
  // confirmed/dismissed/practiced ones already left the inbox, and yesterday's
  // pending captures 已進正式佇列：今天的 rewind 不應再收窄/改寫它們。
  const today = todayStr();
  const overlapping = getCaptures().find(
    (c) =>
      c.episode_id === input.episodeId &&
      c.status === 'pending' &&
      toDateStr(new Date(c.created_at)) === today &&
      windowsOverlap(c.window_start, c.window_end, windowStart, windowEnd),
  );

  if (overlapping) {
    const isSectionSeek =
      lastRewind !== null &&
      lastRewind.episodeId === input.episodeId &&
      now - lastRewind.atMs <= SECTION_SEEK_WINDOW_MS &&
      input.toPos < lastRewind.toPos;

    let merged: Capture;
    if (isSectionSeek) {
      // "找段落" — widen the window (union), do NOT upgrade strength.
      merged = withContext(
        {
          ...overlapping,
          window_start: round1(
            Math.min(overlapping.window_start, windowStart),
          ),
          window_end: round1(Math.max(overlapping.window_end, windowEnd)),
        },
        input.durationSec,
      );
    } else {
      // Genuine second listen of the same segment → strong; the window
      // intersection usually pins down a single sentence (§4). 交集寬度
      // <3s 時（幾乎鎖不到完整句、極端時零寬）改保留 union，仍升級。
      const interStart = Math.max(overlapping.window_start, windowStart);
      const interEnd = Math.min(overlapping.window_end, windowEnd);
      const useIntersection =
        interEnd - interStart >= MIN_INTERSECTION_SECONDS;
      merged = withContext(
        {
          ...overlapping,
          window_start: round1(
            useIntersection
              ? interStart
              : Math.min(overlapping.window_start, windowStart),
          ),
          window_end: round1(
            useIntersection
              ? interEnd
              : Math.max(overlapping.window_end, windowEnd),
          ),
          strength: 'strong',
        },
        input.durationSec,
      );
    }
    upsertCapture(merged);
    lastRewind = {
      captureId: merged.id,
      episodeId: input.episodeId,
      toPos: input.toPos,
      atMs: now,
    };
    return merged;
  }

  const capture: Capture = withContext(
    {
      id: uuidv4(),
      episode_id: input.episodeId,
      window_start: windowStart,
      window_end: windowEnd,
      context_start: windowStart, // recomputed by withContext
      context_end: windowEnd,
      strength: 'weak',
      status: 'pending',
      created_at: new Date().toISOString(),
    },
    input.durationSec,
  );
  upsertCapture(capture);
  lastRewind = {
    captureId: capture.id,
    episodeId: input.episodeId,
    toPos: input.toPos,
    atMs: now,
  };
  return capture;
}

/**
 * Notify the engine of a playback-rate change. Slowing down within 10s of a
 * rewind is a near-certain "didn't understand" signal (§2) → upgrade the
 * capture created/updated by that rewind to 'strong'.
 */
export function noteRateChange(
  episodeId: string,
  newRate: number,
  prevRate: number,
): void {
  if (newRate >= prevRate) return; // only slow-downs are a signal
  if (!lastRewind || lastRewind.episodeId !== episodeId) return;
  if (Date.now() - lastRewind.atMs > SLOWDOWN_UPGRADE_WINDOW_MS) return;
  updateCapture(lastRewind.captureId, { strength: 'strong' });
}

/** Test/dev helper: forget the merge context (e.g. when switching episodes). */
export function resetEngineSession(): void {
  lastRewind = null;
}
