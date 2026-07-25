# Echo — Learn from every rewind

A podcast player that turns your rewinds into your personal English curriculum.

Every time you tap "back 15 seconds," you're telling us what you didn't catch.
Echo captures that moment, diagnoses *why* you missed it (vocab? linking? speed?
grammar? accent? culture?), and builds your daily speaking practice from your own
listening life — not from someone else's textbook. The culminating feature,
**Mirror**, re-speaks the hard sentence back to you *in your own cloned voice*.

**Roadmap:** Podcast app → AirPods in real conversations → AR glasses.

---

## Repo layout

```
CONTEXT.md            ← domain glossary + module map (read this first)
docs/
  00-vision-and-angle.md
  01-product/         signal design, MVP spec, roadmap
  02-execution/       six-week plan + weekly logs
  adr/                Architecture Decision Records (the "why")
app/                  the Expo / React Native iOS app
design/               mockups, demo assets
```

**Start here:** [`CONTEXT.md`](CONTEXT.md) for the vocabulary and how the code is
organized, then [`docs/adr/`](docs/adr/) for the decisions behind it.

> **Note on scope.** This public repo holds the product and the code. Business-strategy
> material (fundraising, competitive positioning, user-research hypotheses) and
> machine-specific run-books are kept **local, out of version control** by design — so
> a few docs referenced from `CLAUDE.md` won't be present in a fresh clone. That's
> intentional, not a broken link.

---

## Quickstart (the app)

```bash
cd app
npm install
cp .env.example .env      # all keys optional — the app runs local-only with none set
npx expo start -c
```

With no keys the app runs in **local-only mode** (data stays on-device, no transcription
or diagnosis). Add `EXPO_PUBLIC_*` keys in `.env` to enable Supabase sync, Whisper
transcription, and Claude diagnosis. See [`app/.env.example`](app/.env.example) for what
each key unlocks and its cost.

Stack: Expo (React Native) · Supabase (Postgres + auth + storage) · Whisper (ASR) ·
Claude (difficulty diagnosis). See the ADRs for why.

---

## Working with this repo (skill-driven workflow)

This repo is set up so a structured, skill-driven agent workflow can extend it safely:

- **`CONTEXT.md`** is the ubiquitous language. Use these terms in specs, commits, and
  code; update it in the same change when the model shifts.
- **`docs/adr/`** records structural decisions. Respect the ADRs covering any area you
  change; supersede rather than edit an accepted one.
- **GitHub Issues** is the intended tracker for specs and tickets.

`CONTEXT.md §4` lists the load-bearing seams and the current refactor candidates (no
test suite yet; `captureEngine` and `srs` are pure and want the first tests) — the
natural first pieces of work.
