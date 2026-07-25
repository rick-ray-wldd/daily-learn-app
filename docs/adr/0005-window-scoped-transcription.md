# ADR-0005 — Window-scoped transcription; RSS official transcript before Whisper

- **Status:** accepted
- **Date:** 2026-07-13

## Context
Whisper costs ~$0.006/audio-minute. Transcribing a full 60-min episode is ~$0.36;
most of it is never needed, because only the neighbourhood of a replay event matters.
Many podcasts also ship an official `podcast:transcript` (SRT/VTT) for free.

## Decision
Transcript source priority is: disk cache → RSS official transcript (free) → Whisper.
When Whisper is used, transcribe only the **window around replay events** (±~2 min),
not the whole episode. The 25 MB OpenAI upload cap is checked before upload.

## Consequences
- ~10× cost reduction vs. whole-episode transcription; cost scales with genuine
  difficulty, not episode length.
- We keep both a paid and a free path (`transcript.ts` + `transcriptFormats.ts`), and
  never transcribe the same episode twice (cached pointer in the store).
