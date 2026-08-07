# Architecture Decision Records

Numbered, append-only records of the structural decisions behind Echo. Once a record
is **accepted**, don't edit its Decision — write a new ADR that **supersedes** it.
Skills (`to-spec`, `implement`, `codebase-design`) are expected to respect the ADRs
covering the area they touch. Copy `0000-template.md` for new ones.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-native-ios-app-over-web.md) | Native iOS app (Expo) over web/PWA | accepted |
| [0002](0002-own-the-podcast-player.md) | Own the podcast player, don't integrate Spotify/Apple | accepted |
| [0003](0003-single-replay-event-pipeline.md) | One replay-event pipeline, distinguished by `trigger_source` | accepted |
| [0004](0004-local-first-store.md) | Local-first store is source of truth; Supabase is best-effort sync | accepted |
| [0005](0005-window-scoped-transcription.md) | Window-scoped transcription; RSS transcript before Whisper | accepted |
| [0006](0006-client-side-audio-slicing.md) | Slice audio on-device; no worker server | accepted |
| [0007](0007-claude-strict-schema-diagnosis.md) | Diagnosis via Claude strict-schema tool call | accepted |
| [0008](0008-provider-keys-to-edge-functions.md) | Client provider keys are dogfood-only → Edge Functions by W3 | accepted |
| [0009](0009-mirror-voice-pipeline.md) | Mirror voice: IndexTTS-2 (proto) → Fish Audio (prod) | accepted |
| [0010](0010-minimal-type-aware-practice.md) | Minimal type-aware practice flow (not six templates, not fully uniform) | accepted |
| [0011](0011-honest-bounded-session.md) | Daily session "honest but bounded": N=5 strong cap, overflow carries over | accepted |
| [0012](0012-single-learning-focus.md) | One learning focus per capture; multi-candidate diagnosis deferred | accepted |
| [0013](0013-anonymous-auth-and-rls.md) | Anonymous auth is the identity floor; RLS scopes every row to its owner | accepted |
| [0014](0014-manufactured-demo-transcripts.md) | 示範單集用自製對齊素材；與產品內容管線分開 | accepted |
| [0015](0015-shell-with-mini-player.md) | 外殼式導覽：分頁 + mini player，播放器／逐字稿是覆蓋層 | accepted |
| [0016](0016-remote-controls-and-inferred-rewind.md) | 系統播放控制項；外部倒帶靠位置推斷回同一條管線 | accepted |
