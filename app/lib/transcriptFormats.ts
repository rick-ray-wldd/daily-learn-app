/**
 * SRT / WebVTT → TranscriptSegment[]。
 *
 * 實測樣本（Buzzsprout）：SRT 用逗號毫秒 `00:00:00,080 --> 00:00:01,439`、
 * cue 首行可能有前導空白、文字可跨多行；VTT 首行 `WEBVTT`、點毫秒、
 * 有 `<v Kevin>` voice tag、允許省略小時（`MM:SS.mmm`）。
 * 壞輸入一律回 []（呼叫端視為失敗）。
 */
import { TranscriptSegment } from './types';

/**
 * "HH:MM:SS,mmm" / "HH:MM:SS.mmm" / "MM:SS.mmm" / "HH:MM:SS"（毫秒選配，
 * 缺省 = 0）→ 秒。失敗回 null。
 */
function timecodeToSeconds(tc: string): number | null {
  const m = tc
    .trim()
    .match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + ms / 1000;
}

interface ParseOptions {
  /** VTT：跳過 WEBVTT/NOTE/STYLE/REGION block、轉換 <v Speaker> tag。 */
  vtt: boolean;
}

function parseCues(text: string, opts: ParseOptions): TranscriptSegment[] {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const segments: TranscriptSegment[] = [];
  let id = 0;

  for (const block of blocks) {
    const trimmedBlock = block.trim();
    if (!trimmedBlock) continue;
    if (
      opts.vtt &&
      /^(WEBVTT|NOTE|STYLE|REGION)/.test(trimmedBlock)
    ) {
      continue;
    }

    const lines = trimmedBlock.split('\n');
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx < 0) continue;

    const [rawStart, rawEnd] = lines[timingIdx].split('-->');
    if (rawEnd === undefined) continue;
    const start = timecodeToSeconds(rawStart.trim().split(/\s+/)[0]);
    // VTT timing 行尾可能帶 `align:start` 等 cue settings → 只取第一個 token
    const end = timecodeToSeconds(rawEnd.trim().split(/\s+/)[0]);
    if (start === null || end === null) continue;

    let content = lines
      .slice(timingIdx + 1)
      .join(' ');
    if (opts.vtt) content = content.replace(/<v\s+([^>]+)>/g, '$1: ');
    content = content.replace(/<[^>]*>/g, '').trim();
    if (!content) continue;

    segments.push({ id: id++, start, end, text: content });
  }
  return segments;
}

export function parseSrt(text: string): TranscriptSegment[] {
  return parseCues(text, { vtt: false });
}

export function parseVtt(text: string): TranscriptSegment[] {
  return parseCues(text, { vtt: true });
}
