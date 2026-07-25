# Domain Docs

This repository uses a single-context domain layout. These rules describe how engineering skills consume its domain documentation.

## Before exploring

Read:

- `CONTEXT.md` at the repository root for the ubiquitous language, bounded context, module map, and architectural seams.
- The accepted ADRs in `docs/adr/` that affect the area being explored or changed.

If one of these resources does not exist, proceed silently. Do not propose placeholder domain documentation upfront; `/domain-modeling` creates or updates it when real terminology or decisions are resolved.

## File structure

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── app/
```

There is no `CONTEXT-MAP.md` and no per-context ADR hierarchy. Introduce a multi-context layout only if the repository genuinely grows into independently modeled contexts.

## Use the glossary vocabulary

When an issue title, specification, refactor proposal, hypothesis, test, or implementation names a domain concept, use the term defined in `CONTEXT.md`.

Do not drift to synonyms that the glossary explicitly rejects. If a needed concept is absent, first determine whether the proposed language is unnecessary. If it represents a genuine domain gap, record it for `/domain-modeling`.

## Follow accepted ADRs

Treat every ADR whose status is `accepted` as binding.

Do not silently override or rewrite an accepted decision. If a decision must change, surface the conflict and create a new ADR that explicitly supersedes the old one.

Use this form when proposing a conflict:

> _Contradicts ADR-XXXX ([decision title]) — worth reopening because…_

## Preserve the public/private boundary

Domain documentation committed to this repository must contain only public-safe information.

Never transfer content from `.gitignore`-excluded local-only strategy documents into `CONTEXT.md`, ADRs, GitHub Issues, or other public repository artifacts.
