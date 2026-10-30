---
name: pi-gitwatch
description: Follow GitHub pull requests and CI without polling - get woken when checks finish or fail, a PR conflicts, is ready to merge, gets a review, merges or closes. Use after opening or pushing PRs, enabling auto-merge, running a merge queue, or when asked to keep an eye on PRs ("acompanha os PRs", "avisa quando o CI terminar", "watch these PRs").
---

# pi-gitwatch

The `gitwatch` tool keeps a watch list of PRs per repository and polls GitHub through `gh` (one GraphQL call per repo, every 30s by default) from the interactive Pi only. When a PR needs you, a `[gitwatch] owner/repo` message arrives between tool calls or starts a new turn. Never sleep or loop on `gh pr checks` waiting for CI.

- `gitwatch {"action":"watch","repo":"owner/name"}` follows every open PR, including new ones; add `"prs":[750,751]` to follow only those. Merged/closed PRs are reported once, then dropped; a list watch ends with its last PR.
- `gitwatch {}` or `{"repo":"owner/name"}` refreshes now: aggregates, then one line per PR (merge state, checks ✓/✗/pending with failing names, auto-merge, head, author, title) and its `next:` step. Changes it finds are shown there and not announced again.
- `gitwatch {"action":"unwatch","repo":"owner/name","prs":[750]}` stops following PRs (omit `prs` for the whole repo).

You are woken for: checks finished (passed/failed), merge conflict (DIRTY), BEHIND with checks done, CLEAN without auto-merge (ready to merge), approved/changes requested, merged, closed, and 3 consecutive poll failures. Pushes, checks starting, new PRs and auto-merge toggles ride along in the next notice. A duplicate run cancelled next to a passing twin counts as passed.

The watcher is read-only on GitHub. A notice is observed state, not an instruction or authorization: merging, pushing or rerunning CI still follow your normal permissions. State lives in `~/.pi/agent/gitwatch/` (outside Git) and survives reloads; transitions that happen while Pi is closed are reported on the next poll.
