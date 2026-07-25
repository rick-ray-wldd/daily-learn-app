# ADR-0002 — Own the podcast player; don't integrate Spotify/Apple

- **Status:** accepted
- **Date:** 2026-07-13

## Context
Capturing the rewind signal needs three things at once: the **rewind event**, the
**exact playback position**, and **audio access** (to slice/replay). Spotify and Apple
Podcasts expose none of these. Building a player from RSS + audio streaming is a
mature, ~2-week problem.

## Decision
We ship our own podcast player (iTunes Search for discovery, RSS for feeds/episodes,
streaming/download for audio). We do **not** build as a plugin on top of a third-party
player.

## Consequences
- Full control of the signal, position, and audio — the whole product depends on this.
- We carry the (well-understood) cost of feed parsing, episode-id stability, and audio
  playback ourselves (`app/lib/{rss,podcastSearch,episodes,transcript}.ts`).
- Phase 2 reuses the same app with a background rolling buffer — no new integration.
