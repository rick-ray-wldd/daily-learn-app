# ADR-0001 — Native iOS app (Expo / React Native) over web/PWA

- **Status:** accepted
- **Date:** 2026-07-13

## Context
The core signal is the **replay event**. Phase 2 depends on capturing rewinds from
**earbud remote commands** (AirPods back-15s / a squeeze) and, eventually, an
always-on rolling audio buffer. A web app / PWA cannot receive iOS remote command
events, run reliable background audio, or hold an on-device audio buffer.

## Decision
We build a native iOS app using **Expo (React Native)**. Expo gives us native
capabilities (background audio, remote command events, filesystem) while keeping a
single TypeScript codebase and fast iteration.

## Consequences
- Phase 2's earbud gestures are reachable without a rewrite — they land on the same
  `replay_events` pipeline (see ADR-0003).
- We accept the App Store / Apple Developer Program dependency (dev build for
  headphone events, TestFlight for beta) as a cost of the native path.
- Some features (headphone remote, on-device ASR) require a dev build, not Expo Go.
