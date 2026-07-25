# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub Issues. Use the `gh` CLI for all operations.

## Public-repository boundary

This is a public GitHub repository. Content excluded by `.gitignore`, especially local-only strategy documents, must remain local.

Never publish, quote, paraphrase, summarize, or otherwise disclose material from ignored private files in an issue, comment, pull request, or other public GitHub surface. Build public tracker content only from information that is safe to commit to this repository.

If an issue cannot be described without exposing local-only material, stop and ask the maintainer for a public-safe formulation.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments with `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close an issue**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically when run inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

Set this to `yes` only if the repository later decides to treat external pull requests as feature requests. The `/triage` skill reads this flag.

When set to `yes`, PRs use the same labels and states as issues through the corresponding `gh pr` commands:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, retaining only `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE`
- **Comment, label, or close**: use `gh pr comment`, `gh pr edit`, or `gh pr close`

GitHub shares one number space across issues and pull requests. Resolve a bare `#42` with `gh pr view 42`, falling back to `gh issue view 42`.

## When a skill says “publish to the issue tracker”

Create a GitHub issue, subject to the public-repository boundary above.

## When a skill says “fetch the relevant ticket”

Run `gh issue view <number> --comments`.

## Wayfinding operations

The `/wayfinder` skill uses one map issue with child issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog. Create it with `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue. Where sub-issues are unavailable, add the child to a task list in the map body and place `Part of #<map>` at the top of the child. Use a `wayfinder:<type>` label: `research`, `prototype`, `grilling`, or `task`.
- **Blocking**: use GitHub native issue dependencies. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the numeric database ID returned by `gh api repos/<owner>/<repo>/issues/<n> --jq .id`.
- **Fallback blocking**: where dependencies are unavailable, place `Blocked by: #<n>, #<n>` at the top of the child body.
- **Frontier query**: list the map’s open children, discard assigned tickets and tickets with open blockers, then select the first remaining ticket in map order.
- **Claim**: `gh issue edit <n> --add-assignee @me`
- **Resolve**: comment with the answer, close the child, then append a public-safe context pointer to the map’s Decisions-so-far.
