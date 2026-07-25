# Repository instructions

## Required context

Before starting any work in this repository:

1. Read `CLAUDE.md` for project constraints, conventions, and the public/private repository boundary.
2. Read `CONTEXT.md` for the domain vocabulary, bounded context, module map, and architectural seams.

Use the terminology defined in `CONTEXT.md` consistently.

## Accepted architectural decisions

Follow every decision in `docs/adr/` whose status is `accepted`.

Before changing an area, read the ADRs relevant to that area. Do not silently contradict or rewrite an accepted decision. If a decision must change, create a new ADR that explicitly supersedes the old one.

## Public repository and local-only material

This is a public GitHub repository.

Files and directories excluded by `.gitignore`, especially local-only strategy documents, are private working material. Never publish, quote, paraphrase, summarize, or otherwise disclose their contents in GitHub Issues or any other public GitHub surface.

GitHub Issues must rely only on information that is safe for the public repository. Preserve the boundary between public repository content and local-only strategy material, even when the private material is available on disk.

## App-specific instructions

For any work under `app/`, also read and follow `app/AGENTS.md`.

Its version-specific Expo documentation rule applies in addition to these repository-wide instructions.
