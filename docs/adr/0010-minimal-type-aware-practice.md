# ADR-0010 — Minimal type-aware practice flow (not six templates, not fully uniform)

- **Status:** accepted
- **Date:** 2026-07-30

## Context
`signal-design.md §5` promises six per-**difficulty-type** practice templates
(vocab → SRS card + sentence-making, linking → slow contrast + shadowing, speed →
laddered re-listen, grammar → structure breakdown, accent → same-accent material,
culture → one-line explanation, *no SRS*). The shipped `Practice.tsx`, however, runs
**one uniform flow** (re-listen → reveal transcript → shadow → SRS card) for every
capture, with `diagnosis.type` used only to render a display card — and it creates an
SRS item for *every* confirmed capture, including `culture`, contradicting §5.

W3 must ship to 10 beta users (TestFlight) with a north-star of session completion
(≥50%). Building all six templates is too much surface for the week; but a fully
uniform flow forces shadowing + SRS on types where it is overkill (`culture`) and
skips cheap, high-value adjustments (slow-first for `linking` / `speed`), both of
which drag completion.

## Decision
We will keep **one shared practice template with a small set of type-driven
exceptions** ("minimal type-aware"):
- `culture` → explanation only; **no shadowing, no SRS item**.
- `linking` / `speed` → start from slow (0.7×) playback.
- `vocab` / `grammar` / `accent` → the standard flow (re-listen → reveal transcript →
  shadow → SRS card).

Difficulty type becomes load-bearing only where it most affects session completion.

## Consequences
- **Easier:** ships within W3; `diagnosis.type` stops being decorative; the session
  shortens on `culture` items.
- **Committed / harder:** the full six-template table of §5 is now explicitly
  **deferred**, not lost — revisit post-beta when retention data justifies the build.
  `culture` no longer produces an SRS item, so the store, `stats.ts`, and the queue
  builder must tolerate a `confirmed` / `practiced` capture that has **no** `SrsItem`
  (the old "one SRS item per confirmed capture" invariant is dropped).
- Supersede this ADR when the full per-type templates are actually built.
- Interacts with [ADR-0011](0011-honest-bounded-session.md) (what "practiced" means)
  and [ADR-0012](0012-single-learning-focus.md) (one focus drives the routing).
