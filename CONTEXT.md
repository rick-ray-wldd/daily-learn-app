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

**Replay event** — one backward seek. Today a Back-15s button press or a
headphone/lock-screen remote command (the latter *inferred* from a sudden backward
jump in playback position — [ADR-0016](docs/adr/0016-remote-controls-and-inferred-rewind.md));
in Phase 2 an AirPods gesture. Every replay event is one row in `replay_events`,
distinguished only by `trigger_source` (`screen` | `headphone` | `lockscreen` |
`select`). The atom the whole product is built on. `select` is the one source that
does **not** accompany a playback-position change — it is an **explicit selection**,
recorded on the same pipeline so nothing downstream has to know the difference.
A **saved term** creates *no* replay event at all (there was no rewind to record;
writing one would fabricate a replay that never happened). _Avoid_: "rewind click",
"skip".

**Rewind signal** — the *interpretation* of replay events as a comprehension gap.
A replay event is raw; the rewind signal is what we infer from it. Not every replay
event is a genuine gap (see **Signal strength**).

**Signal strength** — the graded confidence that a capture means "didn't understand".
**Four-valued, not two** — every `=== 'strong'` binary must account for the other
three ([ADR-0017](docs/adr/0017-explicit-selection-signal.md)):

| | | |
| --- | --- | --- |
| `saved` | — | the learner tapped an **annotation** and said "I want to learn this". **No rewind, no comprehension breakdown.** The weakest level |
| `weak` | ★ | a single rewind then normal progress; possibly just distraction |
| `strong` | ★★★ | same-segment rewind ×2, or rewind-then-slow, or rewind-then-open-transcript |
| `selected` | ★★★★ | rewind + transcript + the learner **pointed at it** — no inference left |

`weak` / `strong` are defined in `docs/01-product/signal-design.md §2`; `selected` is
produced only by **explicit selection**; `saved` only by a **saved term**.

`saved` differs from the other three *in kind, not in degree*: the other three each
have one real rewind behind them, `saved` has one tap. So it may enter the practice
queue (which asks "what does he want to learn") but **never a signal metric** (which
asks "where did comprehension break") — see the `confirm rate` note below.

> **Branch on `strength` with a whitelist, never `!== 'x'`.** A blacklist makes every
> newly added level count *by default*, and this repo has already made that exact
> mistake twice (`selected` leaked into `confirm rate`; then `saved` leaked through the
> `!== 'selected'` patch written to fix it). Whitelists make the next level opt-in.

**Explicit selection（框選）** — the learner tapping the head and the tail of a word
range in the transcript to say "*this* is what I didn't get". Produces a capture with
`strength: 'selected'`, `status: 'confirmed'` (they just answered the confirm question
themselves), a window equal to **that sentence**'s `segment.start/end` rather than the
`[T-15, T]` **capture window**, the chosen words in `selection_text`, and the learner's
own intent in `selection_kind` (`vocab` | `grammar` | `segmentation`). `selection_kind`
is deliberately **not** the six **difficulty types**: those are the app's judgment, this
is the learner's — a mismatch between them is data, not an error. Cross-sentence
selection is not supported. _Avoid_: "highlight"; and never "annotation" — that word
means the opposite (see **Annotation** below).

**Segmentation exit（我聽不出這裡有幾個字）** — the third button on the selection
action bar, for when the learner cannot frame a range **because they never split the
sound into words** (lexical segmentation failure — Field 2003; the most common
listening breakdown that framing silently assumes away). It needs only the **anchor**
tap, submits the **whole sentence** as `selection_text`, and carries
`selection_kind: 'segmentation'`. Still `strength: 'selected'` — they rewound, opened
the transcript, and pointed; only the *granularity* of what they pointed at differs.
It never goes through the vocab/grammar sheet, because being unable to answer that
question is the entire premise. **The one datum no competing app collects**: where a
learner cannot even find the word boundaries. Downstream must read `selection_kind`
before rendering — "you circled these words" is a lie on this row, and the whole
sentence must not be printed on the practice card (it *is* the answer). _Avoid_:
"I don't know", "unclear" — the term names a specific listening failure.

**Saved term（標記想學）** — the learner tapping **＋ 加入練習** on an **annotation**'s
`TermSheet`. Produces a capture with `strength: 'saved'`, `status: 'confirmed'`, the
sentence's window, the term in `selection_text`, and **no** `selection_kind` (asking
"word or pattern?" is evaluation, and the sheet's floor is *never make the listener
judge anything mid-listen*). It is the **only write path in the app that creates no
replay event** — `saved` rows have no row in `replay_events`, by definition, not by
data loss. Idempotent on (episode, sentence, term). The retention argument: reading
an annotation and closing it is the lowest-retention condition in the Involvement
Load Hypothesis; the evaluation load is deferred to the next-day practice card, which
is where it belongs. _Avoid_: "bookmark", "favourite", "highlight".

**Annotation（難點標註）** — the terms the *app* marks up in the transcript as
probably-hard. It is a **guess**, which is why it is amber and explicit selection is
green: green means the learner acted, amber means the app is guessing. The two never
colour the same word — the moment selection mode opens, annotations stand down.
Losing that line would erase the only visual distinction between evidence and
inference, and inference being wrong is the normal case. An annotation is the one
guess the learner can promote into a capture (**saved term**) — which is exactly why
`saved` is fenced out of `weakTypesFromCaptures`: guess → learner saves → guess
influences the next guess is a closed loop with no rewind anywhere in it, and evidence
→ inference is the only direction allowed. _Avoid_: using "annotation" for anything
the learner did.

**Capture** — a graded, windowed unit of difficulty produced from one or more replay
events: an episode-relative difficulty window `[window_start, window_end]`, a padded
`[context_start, context_end]` replay window, a `strength`, and a `status`. Captures
from **explicit selection** additionally carry `selection_text` / `selection_kind`;
a **saved term** carries `selection_text` with no `selection_kind`. Everything
downstream (diagnosis, SRS, daily session) treats them identically, which is the whole
point of not giving these entry points their own tables. The central domain object
(`Capture` in `app/lib/types.ts`). _Avoid_: "clip", "snip", "bookmark".

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

> **`confirm rate`'s population is the whitelist `weak` + `strong` — nothing else.**
> Both `selected` and `saved` captures are born `confirmed`, so counting either turns
> "how accurate is rewind detection" into "how much does this user use that feature".
> Totals and difficulty-type distribution include `selected` (a genuine difficulty)
> but exclude `saved` — otherwise "difficulties captured" quietly becomes "terms
> collected", and that number is the one we quote externally.

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
reviews are done — weak captures need only triage. Captures made *today* — rewound
**or selected** — form a separate 搶先 (get-ahead) tier that does not count toward
completion; the date filter applies to both, or same-day selections (which arrive
already `confirmed`) would walk straight into the official queue. **Saved terms** join
the same queue — it answers "what to practise", not "where comprehension broke" — but
sort **last** (`STRENGTH_RANK`: `saved` = 3), so a ten-minute session spends itself on
real breakdowns first. The product's north-star surface; the bound and cap live in
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

## 2.1 Delivery & platform vocabulary（交付詞彙，**不是**領域詞彙）

These name the **shipping mechanism**, not the product. They live here because the three
platform documents added 2026-08-14 (§5) argue about them constantly and the words were
being used loosely. Keep them out of product prose; use them exactly in build/native
discussions.

**OTA boundary（OTA 界線）** — the line between what `eas update` can ship and what needs
a newly signed binary. One question decides it: *does the change end up inside the
`.ipa`'s binary or bundle resources?* On the OTA side: JS/TS, Metro-imported assets,
Supabase migrations and Edge Functions (the last don't even need OTA — the app doesn't
participate). On the rebuild side: Swift under `app/targets/`, `plugins/*.js`,
`app.json`'s `plugins`/entitlements, **the app icon**, `Info.plist`, and any new native
dependency. This is mechanism, not preference — iOS code signing covers every executable
page and W^X forbids write-then-execute, but review guideline 2.5.2 explicitly exempts
scripts run by WebKit/JavaScriptCore, so **a JS bundle is *data* to iOS, not code**;
swapping data leaves the signature intact. Change Swift and the machine code changes, so
the signature no longer holds and a new binary is unavoidable. Full table:
`docs/02-execution/roadmap-expo-to-native.md` §5.3. _Avoid_: "hot reload" (that's the
dev server), "silent update".

**CNG（Continuous Native Generation）** — this repo keeps **no** `ios/` or `android/` in
git (`app/.gitignore` L40–41); the native project is regenerated by `expo prebuild` from
`app.json` + config plugins on every build. This is a constraint, not trivia: there is no
checked-in Xcode project to hand-edit, so **anything native must be expressible as a
config plugin**. Source: `app/targets/README.md` §1, ADR-0021.

**Config plugin** — a JS function that mutates the generated native project during
`expo prebuild`. Ours is `app/plugins/withEchoWidget.js` (575 lines): it copies
`app/targets/EchoWidget/*` into the generated `ios/` and injects the widget target into
the pbxproj. It is **not wired up** — `app.json`'s `plugins` is still
`["expo-audio","expo-asset","expo-status-bar"]` (`app/app.json:41-45`), so prebuild and
`eas build` behave as if `targets/` did not exist. That is deliberate (ADR-0021), and it
means the plugin has **never run in a real `expo prebuild`** — only its pbxproj *shape*
was checked against a synthetic project. _Avoid_: confusing it with a **local Expo
module** (below); a plugin edits the project, a module ships code.

**Local Expo module（本地原生模組）** — native code compiled into the app itself and
callable from JS, living in this repo rather than npm. None exists today. It is the
proposed shape for the first real Swift work — a ~60-line module that registers its own
`MPRemoteCommandCenter` target so lock-screen rewinds arrive as events instead of being
inferred (`native-app-blueprint.md` §6 階段一). **Estimate, not measurement; unimplemented.**

**Live Activity** — the ActivityKit surface on the Lock Screen / Dynamic Island. Echo's
planned use is a **lock-screen review card** (ADR-0021): one due **SRS item**, three
choices plus an escape hatch — the option set is "三選一 + 想不起來", never "四選一"
(chance is 33%, and the difference has already been stated wrongly). The blueprint is
`app/targets/EchoWidget/` (6 Swift files, 1,160 lines) — **written, never compiled**:
this machine has no Xcode, and the only check ever run is `swiftc -parse`, which neither
resolves modules nor typechecks. _Avoid_: "widget" (a Live Activity is not a home-screen
widget), "notification" (the daily reminder is a different, shipped thing).

**App Intent** — the `AppIntents` type behind a button *inside* a Live Activity
(`LiveActivityIntent`; `app/targets/EchoWidget/EchoAnswerIntent.swift`). Apple runs it in
the **app's process**, which forces two design facts: the shared files must be compiled
into *both* the extension and the main app target — miss the app target and the button
renders normally, does nothing, and reports no error (the one silent failure mode) — and
the answer travels back through an **App Group** file, not a return value. Two unanswered
questions could still kill the design (`app/targets/README.md` §7 ❌1/❌2): whether buttons
fire at all on a locked device, and whether the background wake cold-starts Hermes plus
the whole JS bundle. Both are 待驗證 and only a real device can answer them.

**`runtimeVersion` fingerprint** — a **proposal** to derive `runtimeVersion` from a hash
of the *native inputs* instead of the SDK version. It earns a glossary entry because of
one specific trap: today's `{"policy":"sdkVersion"}` (`app/app.json:52-54`) does **not**
change when a config plugin adds native code, so EAS Update would push JS that assumes a
native module down to a binary that lacks it. `fingerprint` is a legal SDK 57 value
(`node_modules/@expo/config-types/build/ExpoConfig.d.ts:37`) and costs no new dependency,
but it is **not a decision this repo has made** — the word appears nowhere in its docs or
config, the written fallback is `appVersion`, and landing it requires **ADR-0022** first.
Argument and costs: `roadmap-expo-to-native.md` §5.4. _Avoid_: writing it as settled.

**Feature detection（原生模組 feature-detect）** — the repo's *current* answer to that
trap: every native call checks the module is present and skips the whole path if not,
never crashing (`lib/liveActivity.ts:673 checkEligibility()` → `'native-module-missing'`
/ `'ios-too-old'` / `'activities-disabled'`; same precedent as `lib/selection.ts:293`,
"the JS bundle always arrives before the SQL"). **Written, not yet in force**: no file
imports `lib/liveActivity.ts`, so call-site coverage is **0** and the file isn't even in
the Metro graph (`expo export` stays green if you break it; only `tsc --noEmit` covers
it). Treat "feature-detect protects us" as 待驗證 until it has a caller and has been
tested against an old binary.

---

## 3. Bounded contexts

Single-repo, single-context today — so there is **no** `CONTEXT-MAP.md`. The natural
seams if/when this is split (candidates, not yet split):

| Context | Responsibility | Lives in |
| --- | --- | --- |
| **Signal** | replay events → graded captures | `app/lib/captureEngine.ts`, `replay.ts`, `selection.ts` |
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
- **`captureEngine.ts`** — `(replay events) → captures`. Implements signal-design
  §2/§3/§4. **The algorithm is pure; the entry points are not** — `:30` imports
  `getCaptures` / `upsertCapture` / `updateCapture` from `store.ts`, and
  `ingestReplayEvent` reads the store at `:115` and writes at `:169` / `:193`, while
  `noteTranscriptOpen` writes at `:233`. So it does **not** hold the line `srs.ts`
  states in its header ("Pure functions only — persistence lives in `lib/store.ts`")
  and `stats.ts` keeps. Still the **highest-value unit-test target**, but the tests
  need the store stubbed — or, better, the reads/writes lifted to the caller first.
  Lifting them is also the precondition for the "core algorithms must not know the
  persistence layer" invariant that lets the Swift data-layer choice be deferred
  (`docs/02-execution/native-app-blueprint.md` §5). Doable in TS today; needs no Xcode.
  > Corrected 2026-08-14: this entry previously said "pure". It was wrong, and two
  > documents inherited the error from here before it was caught.
- **`srs.ts`** — pure SM-2 functions (persistence lives in `store.ts`). Trivially
  unit-testable.
- **`transcript.ts`** — the async seam over three transcript sources (cache / RSS /
  Whisper). Interface: `transcribe(episode)`. Adapter-swappable.
- **`diagnose.ts`** — the async seam over Claude. Interface: `diagnose(capture)` →
  `Diagnosis | null`. Strict-schema tool call ⇒ guaranteed-parseable output.
- **`selection.ts`** — everything the learner points at by hand. `commitSelection`:
  **explicit selection** (incl. the **segmentation exit**) → one `selected` capture +
  one `select` replay event. `commitSavedTerm`: a **saved term** → one `saved` capture
  and **no** event. Deliberately split into two pure functions (`tokenize`,
  `sliceSelection` — called on every touch, verifiable with no store/network/React)
  and the effectful entry points. Good unit-test target alongside `captureEngine`;
  `commitSavedTerm`'s idempotence on (episode, sentence, term) is the first test to
  write, since the button that calls it is a single tap.
- **`supabase.ts`** — the sync adapter. `null` in local-only mode. Nothing may block
  on it.

Two **UI primitives** are load-bearing enough to name here, because ADR-0018 and
ADR-0020 make every screen depend on them:

- **`components/Glass.tsx` + `Gradient.tsx`** — the material layer, faked in pure JS
  (fill + 1px top sheen + hairline edge + optional semantic bloom). No native module,
  so visual work ships over OTA. Material tokens (`GLASS` / `BLOOM` / `RAMP` / `ELEV`)
  are exported **separately from `C`**, because `C`'s contract is "every key is a
  semantic colour" and material carries no semantics.
- **`components/MasonryList.tsx`** — generic, non-virtualised, shortest-column-first
  list. Knows nothing about Episode. Paging is the only throttle.

**Known shallow / refactor candidates** (fodder for `/codebase-design` + `/to-spec`
later — do not pre-emptively move; decide with tests):
- `episodes.ts` mixes the Episode *model* with hardcoded demo rows — the demo data
  wants to move out before it grows.
- **`store.ts:syncCapture` doesn't know `selection_text` / `selection_kind`**, so
  `selection.ts` does a second remote upsert of its own. Both set only the columns
  they know, so `on conflict (id) do update` can't clobber either way — but it should
  be folded back into one write.
- **"Which captures are eligible today" is implemented twice** — `screens/Practice.tsx`
  (the queue) and `App.tsx:computeBadge` (the tab badge). They have already drifted
  once over the same-day filter. Whichever refactor touches this should collapse them
  into one function in `store.ts` or `stats.ts`. **This is now blocking**: the queue
  has no cap on **saved terms**, and framing costs a long-press plus two taps while
  ＋ 加入練習 costs *one* — one episode can mint ~20 full-flow cards for tomorrow.
  A real N=5 split must change both sides together, or it reproduces the "badge says
  3, screen is empty" bug.
- ⚠️ **`app/supabase/migrations/006_explicit_selection_signal.sql` is not applied to
  the hosted project** (verified: `42703` on `captures.selection_text`, and both CHECK
  constraints still hold the old value sets). The file was **edited in place** rather
  than superseded by a 007, because it has never run anywhere — see ADR-0017's
  Amendment §4 for the rule (has this file run? yes → append only; no → edit in place).
  All three hand-pointed sources therefore sync *nothing*: `saved` / `selected` hit
  `captures_strength_check`, `segmentation` hits `captures_selection_kind_check`, and
  both new columns are missing. Local-first hides it from the user; server-side these
  rows do not exist until 006 runs.
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
- **Platform & migration — three documents added 2026-08-14, meant to be read as a set**
  (vocabulary in §2.1). They answer "Expo or Swift, and when", which nothing else in
  `docs/` covered:
  - `docs/00-why-expo-then-swift.md` — the **rationale memo**, written for readers
    outside the repo (investors, mentors, a future first engineer): why not web, why
    React Native first, why the **OTA boundary** is legal rather than a loophole, what
    Swift actually buys (ranked; the top item is turning the lock-screen rewind signal
    from *inferred* into *measured*), and what it must not be used for. **Argument, not
    plan** — it schedules nothing.
  - `docs/02-execution/roadmap-expo-to-native.md` — the **live master plan**: honest
    state table, what blocks each of the three phases, the pre-8/17 sprint, the
    post-8/17 native path ranked by payoff, the complete OTA-boundary rules, and an
    18-row risk register. §1 is meant to be updated after every EAS Build.
  - `docs/02-execution/native-app-blueprint.md` — **draft proposal; not a decision and
    not a result.** What a pure-Swift Echo would look like, module by module. Every
    Swift claim in it is unverified — its one verified section is §1: the widget sources
    **cannot** be moved to a second repo, because `plugins/withEchoWidget.js:282` reads
    them from the Expo project root.
  - **Precedence:** where these disagree with an ADR, **the ADR wins** — ADRs are
    accepted, these are not. Two ADRs are owed out of them and **neither is written**:
    **ADR-0022** (`runtimeVersion` policy, required *before* the commit that enables the
    config plugin) and a **supersede of ADR-0016** (self-registered remote-command
    target, after the Swift replacement is verified on a real device). Until then
    `runtimeVersion` stays `sdkVersion` and ADR-0016's inference stays in force.
- Business strategy (fundraising, competitors, research hypotheses) is **kept local**,
  not in this repo — see README "Repo layout".
