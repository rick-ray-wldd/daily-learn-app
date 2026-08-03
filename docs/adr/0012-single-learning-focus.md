# ADR-0012 — One learning focus per capture; multi-candidate diagnosis deferred

- **Status:** accepted
- **Date:** 2026-07-30

## Context
`CONTEXT.md` originally modeled diagnosis as a **focus candidate set** — up to three
candidate difficulties per capture, each separately confirmed by the learner, one of
which becomes the **learning focus**. But `diagnose.ts` (the strict-schema call of
[ADR-0007](0007-claude-strict-schema-diagnosis.md)) returns exactly **one** difficulty
type + **one** `focus_phrase`, and the W3 practice loop
([ADR-0010](0010-minimal-type-aware-practice.md),
[ADR-0011](0011-honest-bounded-session.md)) runs on that single diagnosis. Keeping the
multi-candidate vocabulary in the live glossary describes a product that does not
exist and would mislead any skill or agent that specs against it.

## Decision
We will treat each capture as carrying **exactly one learning focus** — the single
`focus_phrase` of its diagnosis — and **Focus confirmation** collapses to the
capture-level **Confirm / Dismiss** judgment. The multi-candidate model (a focus
candidate set of up to three, with per-candidate confirmation) is **deferred past
beta**: it multiplies confirm decisions per capture, which lengthens the session
(against ADR-0011) and dilutes the clarity of the confirm signal, in exchange for a
finer-grained weakness profile whose payoff only matters once retention data exists.

## Consequences
- **Easier:** `CONTEXT.md` matches the code; the confirm gesture stays a single tap;
  the session stays short.
- **Committed / harder:** the "which of several difficulties tripped you" data is not
  collected in W3, so the **comprehension profile** is coarser (one focus/type per
  capture). This ADR is the home of the candidate-set idea now — it is preserved here,
  not in the glossary. Supersede it when multi-candidate diagnosis is actually built.
