# ADR-0007 — Diagnosis via Claude strict-schema tool call

- **Status:** accepted
- **Date:** 2026-07-13

## Context
The diagnosis layer classifies each capture into the six difficulty types and must
return machine-usable structured output — free-text parsing is fragile and would break
the practice-template routing.

## Decision
`app/lib/diagnose.ts` calls the Claude API and forces output through a
**strict-schema tool call** (`strict: true` + `tool_choice`), so the response is
guaranteed-parseable JSON matching the `Diagnosis` shape. Default model is
`claude-haiku-4-5` (fast, well under $0.01 per diagnosis); overridable via
`EXPO_PUBLIC_DIAGNOSE_MODEL`.

## Consequences
- No free-text parsing; the diagnosis either validates or is treated as absent.
- Diagnosis is an **optional** feature — with no Anthropic key the practice card simply
  skips diagnosis and the rest of the loop is unaffected.
- The accumulating per-learner diagnosis history is the seed of the data moat.
