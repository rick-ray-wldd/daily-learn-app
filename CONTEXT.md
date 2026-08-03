# CONTEXT — daily-learn-app (Project Echo)

> The project's **ubiquitous language** and **module map**. Every skill, spec, ADR,
> and commit should use these terms exactly. If a new term is coined or an old one
> changes meaning, update this file in the same change (see `docs/adr/` for the
> *why* behind structural decisions).
>
> This is the file Matt's `domain-modeling` / `to-spec` / `codebase-design` skills
> read for vocabulary and seams. Keep it sharp.

---

## 1. What the product is (one paragraph)

Echo is an iOS podcast app whose thesis is that **every rewind is a hidden signal that
the listener didn't understand something**. It captures those rewinds with zero
interruption, diagnoses *why* comprehension broke (vocab / linking / speed / grammar /
accent / culture), and turns each into next-day practice — culminating in **Mirror**:
hearing the hard sentence spoken fluently *in the learner's own cloned voice*
(golden-speaker effect). Three phases share one event pipeline: podcast app → earbud
real-life capture → AR-glasses ambient coach.

---

## 2. Glossary (ubiquitous language)

Use these terms exactly. _Avoid_ the listed substitutes — consistency is the point.

**Active podcast learner（主動型 podcast learner）** — a learner who already
responds to comprehension gaps while listening by replaying, looking things up, or
recording difficult language for later study. The core learner for Phase 1.
_Avoid_: "heavy learner", "power user".

**Casual podcast learner（順便型 podcast learner）** — a learner who wants to
improve their English through podcasts but normally stops at listening or replaying,
without systematically organising difficult language for later study.
_Avoid_: "light learner".

**Comprehension profile（理解能力輪廓）** — an evolving, multidimensional view of
a learner's English listening comprehension across the six difficulty types. An
optional initial level may seed it, but real listening and practice evidence
continually revises it. _Avoid_: "AI level", "fixed proficiency score".

**Audio–text contrast probe（音訊—文字對照校準）** — a short onboarding activity
whose starting difficulty is chosen from a learner's self-assessment. The learner
first listens without a transcript, then uses the revealed text to distinguish what
they heard, what they knew only in writing, and what they did not know; the result
seeds the comprehension profile with low confidence and becomes their first
demonstration capture. _Avoid_: "placement test", "CEFR test".

**Replay event** — one backward seek. Today a Back-15s button press; in the dev-build
phase a headphone/lock-screen remote command; in Phase 2 an AirPods gesture. Every
replay event is one row in `replay_events`, distinguished only by `trigger_source`.
The atom the whole product is built on. _Avoid_: "rewind click", "skip".

**Rewind signal** — the *interpretation* of replay events as a comprehension gap.
A replay event is raw; the rewind signal is what we infer from it. Not every replay
event is a genuine gap (see **Signal strength**).

**Signal strength** — the graded confidence that a replay event means "didn't
understand": `strong` (★★★ — same-segment rewind ×2, or rewind-then-slow, or
rewind-then-open-transcript) vs `weak` (★ — a single rewind then normal progress;
possibly just distraction). Defined in `docs/01-product/signal-design.md §2`.

**Capture** — a graded, windowed unit of difficulty produced from one or more replay
events: an episode-relative difficulty window `[window_start, window_end]`, a padded
`[context_start, context_end]` replay window, a `strength`, and a `status`. The
central domain object (`Capture` in `app/lib/types.ts`). _Avoid_: "clip", "snip",
"bookmark".

**Learning focus（學習焦點）** — the single word, phrase, sound pattern, grammatical
structure, accent feature, or cultural reference a capture's **diagnosis** pins as the
thing the learner struggled with. Exactly **one per capture** (surfaced in code as
`Diagnosis.focus_phrase`). _Avoid_: "keyword".

**Focus confirmation（焦點確認）** — the learner's judgment, made during next-day
triage, of whether a capture's **learning focus** was something they actually
struggled with at the time of the **replay event**. It is the same capture-level
**Confirm / Dismiss** gesture, read as a judgment about the focus; separate from
whether they already knew it or mastered it after practice. _Avoid_: "known/unknown"
as a substitute for this judgment.

> A capture carries **one** learning focus, not a set of competing candidates. The
> earlier multi-candidate model (a "focus candidate set" of up to three) is
> **deferred** — see [ADR-0012](docs/adr/0012-single-learning-focus.md).

**Capture accuracy（Capture 準確度）** — the combined quality of identifying a
genuine comprehension gap, preserving the correct full-sentence window, and finding
the correct learning focus. `confirm rate` measures only the first part; diagnosis
usefulness is evaluated separately. _Avoid_: using "confirm rate" for end-to-end
accuracy.

**Capture status** — the state machine axis: `pending` → `confirmed` | `dismissed`,
and `practiced`. `pending` captures surface in tomorrow's session; the learner
confirms ("really didn't get it") or dismisses ("just distracted"). _Avoid_:
"seen/unseen".

<!-- signal-design.md §-references below point at docs/01-product/signal-design.md -->


**Capture window / context window** — the difficulty window is `[T-15, T]` for a
rewind at position `T`; the context window pads it ±6s so the practice screen can
replay a full sentence plus one sentence either side. Two same-segment rewinds → the
window is their **intersection** (locks onto the single hard sentence).

**Confirm / Dismiss** — the learner's next-day triage of a `pending` capture. This
single gesture is simultaneously (a) free labeled data (noise annotation), (b) a
second exposure to the difficulty (spaced review), (c) the moment the app feels like
it understands them. **Never** shown as a modal during listening — interrupting the
listening flow is forbidden (the Snipd lesson).

**Diagnosis** — the LLM's classification of *why* a capture was hard: a single
**difficulty type** (`vocab` | `linking` | `speed` | `grammar` | `accent` |
`culture`), the one **learning focus** that caused it, a short explanation, and a
practice tip. Forced through a strict-schema tool call, so the output is
guaranteed-parseable. The difficulty type routes the capture to its **practice
template**. **The diagnosis layer is the start of the moat** — the longer it runs, the
better it knows *this* learner's weakness pattern.

**Difficulty type** — the six-way classification above. _Avoid_: "category", "tag".

**Practice template** — the treatment a capture receives in the **daily session**,
selected by its **difficulty type**. W3 runs one shared template (re-listen → reveal
transcript → shadow → SRS card) with type exceptions: `culture` gets an explanation
only (no shadowing, no **SRS item**); `linking` / `speed` start from slow (0.7×)
playback. The full per-type templates of signal-design §5 are deferred — see
[ADR-0010](docs/adr/0010-minimal-type-aware-practice.md). _Avoid_: "lesson type".

**Mirror** — the golden-speaker feature: the hard sentence re-spoken in the learner's
own cloned voice (fluent version), heard alongside the native original and the
learner's own shadowing recording. Prototype voice = IndexTTS-2 (local); production =
Fish Audio. _Avoid_: "TTS", "voice-over" (too generic).

**Voice profile** — the learner's registered voice (a 60–90s onboarding reading),
reused as: Fish clone sample, IndexTTS-2 speaker reference, and pronunciation baseline.
Stored in `voice_profiles`.

**Daily session** — the once-a-day practice queue built from the previous day: all
carried-over `pending` captures (strong first) for triage, the day's due **SRS items**,
and the practice of the session's **strong** captures. It is **complete** when every
pending capture is triaged, every in-scope strong capture is practiced, and all due
reviews are done — weak captures need only triage. Captures rewound *today* form a
separate 搶先 (get-ahead) tier that does not count toward completion. The product's
north-star surface; the bound and cap live in
[ADR-0011](docs/adr/0011-honest-bounded-session.md). _Avoid_: "lesson".

**SRS item** — a simplified SM-2 spaced-repetition record, one per confirmed capture
(`ease` from 2.5, `interval_days`, `due_date`, `reps`).

**Episode** — a podcast episode. RSS-sourced episode id is stable:
`'rss-' + stableHash(guid || 'enc:' + enclosureUrl)` — so a re-fetched feed keeps the
same id and every `captures.episode_id` stays valid.

**Transcript** — per-episode text with timestamps. Source priority: disk cache →
RSS official transcript (`podcast:transcript`, free) → Whisper (paid, windowed).
A `TranscriptSegment` is one timestamped sentence-ish chunk.

**Local-only mode** — the app runs fully without Supabase: replay events and captures
live in the on-device store, sync is a no-op. Supabase is an *optional* sync target,
never a dependency.

---

## 3. Bounded contexts

Single-repo, single-context today — so there is **no** `CONTEXT-MAP.md`. The natural
seams if/when this is split (candidates, not yet split):

| Context | Responsibility | Lives in |
| --- | --- | --- |
| **Signal** | replay events → graded captures | `app/lib/captureEngine.ts`, `replay.ts` |
| **Content** | podcast search, RSS, episodes, transcripts | `app/lib/{podcastSearch,rss,episodes,transcript,transcriptFormats}.ts` |
| **Diagnosis** | LLM difficulty classification | `app/lib/diagnose.ts` |
| **Practice** | daily session, SRS, stats, notifications | `app/lib/{srs,stats,notifications}.ts`, `screens/Practice.tsx` |
| **Persistence** | local store + best-effort sync | `app/lib/{store,supabase,hash}.ts` |

---

## 4. Module map & seams (for `codebase-design` / `to-spec`)

The app is intentionally a flat `app/lib/*` of mostly **deep modules** — small
interface, real behaviour behind it. The load-bearing seams (prefer these when
speccing tests — the fewer seams the better):

- **`store.ts`** — *the* seam. Single source of truth for captures / SRS / transcript
  pointers / practice records. `get*` + mutators + `subscribe`. Best seam to test
  practice/SRS logic through. Deep.
- **`captureEngine.ts`** — pure: `(replay events) → captures`. Implements
  signal-design §2/§3/§4. Testable in isolation; **highest-value unit-test target.**
- **`srs.ts`** — pure SM-2 functions (persistence lives in `store.ts`). Trivially
  unit-testable.
- **`transcript.ts`** — the async seam over three transcript sources (cache / RSS /
  Whisper). Interface: `transcribe(episode)`. Adapter-swappable.
- **`diagnose.ts`** — the async seam over Claude. Interface: `diagnose(capture)` →
  `Diagnosis | null`. Strict-schema tool call ⇒ guaranteed-parseable output.
- **`supabase.ts`** — the sync adapter. `null` in local-only mode. Nothing may block
  on it.

**Known shallow / refactor candidates** (fodder for `/codebase-design` + `/to-spec`
later — do not pre-emptively move; decide with tests):
- `episodes.ts` mixes the Episode *model* with hardcoded demo rows — the demo data
  wants to move out before it grows.
- Whisper/Claude live client-side today; **ADR-0008** already commits to moving them
  behind Supabase Edge Functions (W3). That refactor is the first big `implement` job.
- No test suite yet. `captureEngine` + `srs` are pure and should get the first tests
  before any restructuring (Matt's `implement` runs `/tdd` at pre-agreed seams).

---

## 5. Where the *why* lives

- Product reasoning: `docs/00-vision-and-angle.md`, `docs/01-product/signal-design.md`,
  `docs/01-product/mvp-spec.md`, `docs/01-product/roadmap.md`.
- Structural decisions & their rationale: **`docs/adr/`** (numbered, immutable once
  accepted; supersede rather than edit).
- Execution cadence: `docs/02-execution/` (six-week plan + weekly logs).
- Business strategy (fundraising, competitors, research hypotheses) is **kept local**,
  not in this repo — see README "Repo layout".
