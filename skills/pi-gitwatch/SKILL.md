---
name: pi-gitwatch
description: Follow GitHub pull requests and CI (including a direct push to main) without polling - get woken when checks fail or finish, a PR conflicts, is ready to merge, auto-merge is stuck, gets a review, merges or closes. Use after opening or pushing PRs or commits, enabling auto-merge, running a merge queue, when inspecting notice delivery counters or a delivery failure, or when asked to keep an eye on PRs or CI ("acompanha os PRs", "avisa quando o CI terminar", "watch these PRs").
---

# pi-gitwatch

The `gitwatch` tool keeps a watch list of PRs per repository and polls GitHub through `gh` (one GraphQL call per repo, every 30s by default) from the interactive Pi only. When a PR needs you, a `[gitwatch] owner/repo` message arrives between tool calls or starts a new turn. Never sleep or loop on `gh pr checks` waiting for CI.

- A successful `gh pr create` or `git push` run through bash is followed automatically: the PR it printed, the pushed branch's open PR, or (without a PR) the CI of the pushed commit. The command output ends with `[gitwatch] now following ...`; do not watch it again or start `gh run watch`.
- `gitwatch {"action":"watch","repo":"owner/name"}` follows every open PR, including new ones; add `"prs":[750,751]` to follow only those, or `"branch":"main"` to follow the CI of that branch's latest commit until it finishes. Merged/closed PRs are reported once, then dropped; a list watch ends with its last PR or branch.
- `gitwatch {}` or `{"repo":"owner/name"}` refreshes now: aggregates, then one line per PR (merge state, checks ✓/✗/pending with failing names, auto-merge, head, author, title) and its `next:` step. Changes it finds are shown there and not announced again.
- `gitwatch {"action":"unwatch","repo":"owner/name","prs":[750]}` stops following PRs (omit `prs` for the whole repo).

You are woken for: checks failed, checks passed without auto-merge, merge conflict (DIRTY), BEHIND with checks done, CLEAN without auto-merge (ready to merge), auto-merge still open 10 min after checks passed, approved/changes requested, a merge without auto-merge, closed, a watched branch's CI finishing, and 3 consecutive poll failures. With auto-merge on, passing checks and the merge itself need no turn: the merge is recorded for your next turn. When work waits on that merge (a reload, a release step), watch it with `{"action":"watch","repo":"o/r","prs":[N],"awaitMerge":true}` to be woken. Pushes, checks starting, new PRs and auto-merge toggles ride along in the next notice. A failure's `next:` line gives `gh run view <id> --repo owner/name --log-failed` for the failing Actions runs. A duplicate run cancelled next to a passing twin counts as passed.

After a PR you pushed from this machine merges, its local branches that still point exactly at the merged head are deleted, and a linked worktree holding one is removed with plain `git worktree remove` (never `--force`): a worktree with uncommitted files, a branch checked out in the main worktree, a branch with later commits and `main`/`master`/`trunk`/`develop` are kept. The notice ends with a `Local cleanup in <clone>:` line saying what was removed or kept.

For measurement, `status` separates routing decisions from host-accepted wake requests/next-turn notices and uncertain dispatches. Counters span all repositories since the displayed Brasília date/time, including with a repo filter or after the final watch ends. An absent delivery baseline means unmeasured, not zero. A host acceptance is not a model run or a saved turn; these are not weekly event rates. Rejected sends warn locally and are not replayed: inspect the session before deciding on any retry.

The watcher is read-only on GitHub. A notice is observed state, not an instruction or authorization: merging, pushing or rerunning CI still follow your normal permissions. State lives in `~/.pi/agent/gitwatch/` (outside Git) and survives reloads; transitions that happen while Pi is closed are reported on the next poll.
