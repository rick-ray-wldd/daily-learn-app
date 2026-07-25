# ADR-0004 — Local-first store is the source of truth; Supabase is best-effort sync

- **Status:** accepted
- **Date:** 2026-07-13

## Context
A dogfooding founder (and early beta users) must be able to use the app with no
account and no network hiccups blocking the core loop. Supabase is wanted for
cross-device sync and server-side work, but must not be a hard dependency in W1.

## Decision
`app/lib/store.ts` (AsyncStorage + in-memory cache + `subscribe`) is the single source
of truth for captures, SRS items, transcript pointers, and practice records. Every
mutation updates memory, notifies listeners, then fire-and-forgets persistence and a
**best-effort** Supabase upsert. If `EXPO_PUBLIC_SUPABASE_*` is unset, the app runs in
**local-only mode** and sync is a no-op.

## Consequences
- The app never waits on, nor fails because of, the network.
- Supabase schema mirrors the local types (`types.ts` ↔ `001_init.sql`) so sync is a
  column-for-field upsert.
- Conflict resolution across devices is deferred until multi-device is real.
