# ADR-0011 — Daily session is "honest but bounded": N=5 strong cap, overflow carries over

- **Status:** accepted
- **Date:** 2026-07-30

## Context
The north-star is **weekly completed daily sessions / active user**, with a
completion-rate target of ≥50% and a "~10 minute" session promise. The operational
definition of "complete" is therefore the metric. Two naive definitions both fail:
- **Triage-only** ("done once every pending capture is confirmed/dismissed") inflates
  the north-star into a vanity number — swiping is not learning, and retention would
  not follow it.
- **Practice-everything** ("done once every confirmed capture is practiced") makes a
  heavy-rewind day (15+ captures) impossible to finish in ~10 min, cratering
  completion exactly when the user got the most signal.

A rough budget (triage ~10 s/item, due review ~20 s/item, a full strong practice
~60–90 s) leaves room for roughly **five** strong practices inside ten minutes.

## Decision
We will define a **daily session** as complete when:
1. every carried-over `pending` capture is **triaged** (Confirm / Dismiss),
2. every **in-scope strong** capture is **practiced**, and
3. all **due SRS reviews** are done.

Weak captures require only triage; they never block completion. The strong-practice
tier is **capped at N = 5** per session. Strong captures beyond the cap **carry over
to the next day**, highest signal-strength first, and are **never dropped**. Captures
rewound the *same* day form a separate get-ahead (搶先) tier that does **not** count
toward completion. `N` is a fixed constant for W3; adaptive pacing is deferred.

## Consequences
- **Easier:** the north-star reflects real practice, not swiping; session length is
  bounded near the 10-minute promise; carryover creates a gentle open-loop backlog
  that pulls the user back tomorrow.
- **Committed / harder:** we need session-scope selection (which strong captures are
  "in scope" today) plus carryover bookkeeping. The completion metric must be computed
  against *this* definition — not the current "reached the end of the queue" proxy in
  `Practice.tsx`. A user sustaining >5 strong/day accumulates backlog; monitor it, and
  revisit with adaptive `N` or backlog-aging if it demoralizes.
- Builds on [ADR-0010](0010-minimal-type-aware-practice.md) for what "practiced" means
  per difficulty type.
