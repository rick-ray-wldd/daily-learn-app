# ADR-0013 — Anonymous auth is the identity floor; RLS scopes every row to its owner

- **Status:** accepted
- **Date:** 2026-08-03

## Context
ADR-0008 scheduled the provider keys out of the client bundle and into Edge Functions.
Implementing it surfaced that the key was only one of three holes, all with the same
root cause: **the app had no authentication at all** (`persistSession: false`, no
`signIn` anywhere, `user_id` nullable and never written).

1. Moving the keys server-side stops key *extraction* but not *abuse*. Supabase Edge
   Functions default to `verify_jwt: true`, and the anon key is itself a valid JWT that
   necessarily ships in the bundle — so anyone who unpacks the `.ipa` could call
   `diagnose`/`transcribe` and spend our Anthropic/OpenAI budget.
2. `001_init.sql` opened every table with `to anon using (true)`. Handed to 10 external
   beta users, each of them could read every other user's replay events, captures, and
   diagnoses.
3. The north-star metric is *completed daily sessions per active user* and the confirm
   rate is per-user; with a null `user_id` the beta would produce unattributable data.

`001_init.sql:8-10` and `:132-134` already carried `TODO(上線前)` for exactly this.
Shipping to external TestFlight testers **is** that "上線前".

## Decision
Every install signs in **anonymously** (`supabase.auth.signInAnonymously()`), with the
session persisted to AsyncStorage. An anonymous user takes the `authenticated` Postgres
role and carries an `is_anonymous` JWT claim, which makes it the identity floor for all
three concerns:

- **RLS** (migration 002): every personal table is `to authenticated` with
  `auth.uid() = user_id`, and `user_id` defaults to `auth.uid()` with an FK to
  `auth.users`. `episodes` stays a shared catalogue, readable and writable by any
  signed-in user.
- **Edge Functions**: reject any caller that resolves to no user, which is precisely the
  anon-key-only case.
- **Budget**: auth alone is not a spend cap, because anonymous sign-up is open. A
  per-user daily quota (`api_usage` + `consume_api_quota()`, checked atomically in
  Postgres, failing closed) is the actual guard.

No signup screen. The account is deliberately unrecoverable — lost on reinstall or
device change — which is the right trade for a 6-week beta and can be upgraded in place
later by linking an email identity.

## Consequences
- **Requires a dashboard toggle**: Anonymous sign-ins must be enabled in Supabase
  (Authentication → Providers). Without it every install silently falls back to
  local-only mode.
- **Legacy rows go dark, not away.** Existing demo rows with `user_id IS NULL` stop
  being readable under the new policies (`NULL = auth.uid()` is never true). Migration
  002 deliberately deletes nothing.
- **Anonymous users accumulate** in `auth.users`, one per install (Supabase rate-limits
  sign-up to 30/hour/IP). They need periodic cleanup once the beta ends.
- **Interaction with ADR-0006** — not superseded. Practice-clip slicing stays on-device
  and the backend stays Supabase-only with no worker server. What changed is narrower:
  for the *Whisper* path the episode mp3 is now fetched **server-side** from `audioUrl`
  rather than downloaded and uploaded by the phone. ADR-0006's reasoning (no ffmpeg on
  Deno, no extra worker) is untouched — the function proxies bytes, it does not
  transcode.
- **Interaction with ADR-0005** — an existing gap is now cheaper to close, but is still
  open. ADR-0005 specifies transcribing only the ±2-minute window around replay events;
  the client code never implemented that and sent whole episodes to Whisper. This
  migration preserves that behaviour verbatim, so the cost profile is unchanged (~$0.15
  for a 25-minute episode). Now that the fetch happens server-side, window-scoping
  becomes implementable without an app release — it should be picked up as its own
  change, and the per-user daily quota is the interim cost ceiling.
