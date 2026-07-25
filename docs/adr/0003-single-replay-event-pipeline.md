# ADR-0003 — One replay-event pipeline, distinguished by `trigger_source`

- **Status:** accepted
- **Date:** 2026-07-13

## Context
Rewinds will arrive from several sources over time: an on-screen Back-15s button
(today), headphone/lock-screen remote commands (dev-build phase), AirPods gestures and
an ambient buffer (Phase 2). Modelling these as separate flows would fork the codebase
along the product's most important axis.

## Decision
Every backward seek — regardless of source — becomes one row in `replay_events`,
carrying a `trigger_source` column. The capture pipeline
(`replay.ts` → `captureEngine.ts`) is source-agnostic.

## Consequences
- Phase 2's real-life mode is "a new `trigger_source`", not a new pipeline — near-zero
  change to capture logic.
- All signal-strength / windowing rules live in one place (`captureEngine.ts`) and
  apply uniformly.
