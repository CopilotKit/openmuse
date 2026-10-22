# Issue tracker: GitHub

Issues and specs for this repository live in GitHub Issues at `1123786563/openmuse`. Use the authenticated `gh` CLI.

## Conventions

- **Create an issue:** `gh issue create --repo 1123786563/openmuse --title "..." --body-file <prepared-file>`. Prepare multiline bodies in a file first.
- **Read an issue:** `gh issue view <number> --repo 1123786563/openmuse --comments`. Fetch labels and related issue metadata when needed.
- **List issues:** `gh issue list --repo 1123786563/openmuse --state open --json number,title,body,labels,comments` with suitable limits and filters.
- **Comment on an issue:** `gh issue comment <number> --repo 1123786563/openmuse --body-file <prepared-file>`.
- **Apply or remove labels:** `gh issue edit <number> --repo 1123786563/openmuse --add-label "<label>"` or `--remove-label "<label>"`.
- **Close an issue:** `gh issue close <number> --repo 1123786563/openmuse --comment "..."`.

## Pull requests as a request surface

**PRs as a request surface: no.** External pull requests are not automatically part of the issue intake queue.

## When a skill says “publish to the issue tracker”

Create a GitHub issue in `1123786563/openmuse`.

## When a skill says “fetch the relevant ticket”

Read the referenced GitHub issue, including its labels and discussion.

## Wayfinding operations

Used by `/wayfinder`. A map is one GitHub issue with child decision issues.

- **Map:** one issue labelled `wayfinder:map`, containing Notes, Decisions-so-far, and Fog.
- **Child ticket:** link as a native GitHub sub-issue. If sub-issues are unavailable, use a task list in the map and a `Part of #<map>` line on the child.
- **Blocking:** use GitHub's native issue dependencies. If unavailable, put `Blocked by: #<number>` near the top of the child. Containment alone does not imply a dependency.
- **Frontier:** choose an open, unclaimed child whose blocking issues are all closed.
- **Claim and resolve:** assign the issue before work; record the decision in a comment, close it, and link the result from the map.
