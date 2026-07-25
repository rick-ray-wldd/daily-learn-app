# ADR-0006 — Slice audio on-device; no worker server

- **Status:** accepted
- **Date:** 2026-07-13

## Context
Practice needs 15-second audio clips around each capture. The audio is already on the
phone during listening. Supabase Edge Functions run on Deno and cannot run ffmpeg, so
server-side slicing would force a separate worker server into the stack.

## Decision
Slice audio **on the client** (expo-audio / ffmpeg-kit in the dev build) and upload the
short clip, rather than re-fetching whole episodes server-side and slicing there.

## Consequences
- No extra worker server; the backend stays Supabase-only.
- Upload volume is tiny (a clip, not an episode).
- Some slicing needs a dev build (Expo Go has no ffmpeg) — acceptable given ADR-0001.
