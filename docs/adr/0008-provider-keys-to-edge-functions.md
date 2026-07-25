# ADR-0008 — Client provider keys are dogfood-only; move to Edge Functions by W3

- **Status:** accepted
- **Date:** 2026-07-13

## Context
`EXPO_PUBLIC_*` env vars are baked into the JS bundle — anyone with the app can read
the OpenAI/Anthropic keys. This is acceptable **only** for single-founder dogfooding,
never for a shipped app.

## Decision
For the prototype phase, Whisper and Claude are called directly from the client with
`EXPO_PUBLIC_*` keys. By **W3**, both calls move behind **Supabase Edge Functions**
holding server-side keys; the client stops carrying provider keys entirely.

## Consequences
- Short-term velocity now, with a known and scheduled security debt.
- The W3 migration is the first substantial `implement` job; `transcript.ts` and
  `diagnose.ts` keep their current interfaces so the swap is behind the existing seams.
