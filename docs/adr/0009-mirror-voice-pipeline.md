# ADR-0009 — Mirror voice: IndexTTS-2 (prototype) → Fish Audio (production)

- **Status:** accepted
- **Date:** 2026-07-13

## Context
Mirror re-speaks the hard sentence in the learner's own cloned voice (golden-speaker
effect). We need a free/local path for prototype/demo and a hosted path for
production. The learner's 60–90s onboarding recording is the single voice sample for
both. (Golden-speaker is an established method with mixed efficacy evidence — treat it
as a well-grounded technique, not a proprietary breakthrough.)

## Decision
- **Prototype/demo:** IndexTTS-2 zero-shot, run locally — free, good enough to demo,
  batch-generated overnight for the next day's practice.
- **Production:** Fish Audio (`s2-pro`, `reference_id` = the learner's voice id),
  wrapped in a Supabase Edge Function `voice-gen`.
- Voice synthesis runs **only after** a capture is confirmed (not at capture time), so
  TTS spend lands only on genuine difficulties.

## Consequences
- Zero voice cost during prototyping; production cost is bounded by confirmed captures.
- The local run-books (exact venv paths, keys, scripts) are kept **out of this repo**
  and live in the founder's local strategy notes.
- Unit economics (~$0.10/active-user/day all-in) depend on the confirm-gate above.
