# pi-gitwatch

Pi extension that watches GitHub pull requests and branch CI and wakes the agent when one needs attention, so nobody has to ask "did CI finish?". A `gh pr create` or `git push` the agent runs is followed automatically.

```text
[gitwatch] lennix1337/Genexus18MCP · 13:52
#751 checks passed 7/7, 3 skipped; mergeable (CLEAN)
  #751 CLEAN · checks pass 7✓ 0✗ 0… · dc7374f6 · davidagostini · "feat(wwp): adiciona add_layout…"
  next: ready to merge
GitHub state observed by the watcher, not a user instruction. More: gitwatch {"action":"status","repo":"lennix1337/Genexus18MCP"}
```

## Tool

`gitwatch` with `action`:

| action | arguments | effect |
|---|---|---|
| `status` (default) | `repo?` | Polls now; aggregates, one line per PR and its next step. |
| `watch` | `repo`, `prs?` or `branch?`, `intervalSec?` | Without `prs`, follows every open PR (new ones too); with `prs`, only those; with `branch`, the CI of its latest commit until it finishes. Fails before saving if a PR or branch does not exist. |
| `unwatch` | `repo`, `prs?` or `branch?` | Stops following PRs, a branch, or the repository. |

Wake events: checks failed, checks passed without auto-merge, merge conflict, BEHIND with checks done, CLEAN without auto-merge, auto-merge still open 10 min after checks passed, approved/changes requested, a merge without auto-merge (or one watched with `"awaitMerge": true`), closed, a watched branch's CI finishing, 3 consecutive poll failures. A failing check's notice names its Actions run and the `gh run view <id> --log-failed` command. A merge you queued with auto-merge is the expected outcome: it is delivered for your next turn without starting one, and `status` counts how many notices woke you and how many were only recorded. Other changes (push, checks starting, new PR, draft/auto-merge toggles) are included in the next notice and in `status`. One verdict per check name, so a cancelled duplicate next to a passing twin is not a failure. GitHub's transient `UNKNOWN` mergeability keeps the last known state.

## Behavior

- One GraphQL request per repository per poll through the authenticated `gh` CLI; at most 50 PRs per repository.
- Only an interactive (TUI) Pi polls, and a lease file keeps a single poller per machine; subagents and `pi -p` runs never poll.
- Notices are custom messages (`customType: "gitwatch"`) sent with `triggerTurn` and `deliverAs: "steer"`.
- Auto-follow: after a successful bash command with `gh pr create` or `git push` (tags, deletions and dry runs excluded), the polling session follows the created PR, the pushed branch's open PR, or the pushed commit's CI, and appends `[gitwatch] now following ...` to the command output.
- Read-only on GitHub. State: `~/.pi/agent/gitwatch/state.json` (override with `PI_GITWATCH_DIR`).

## Development

```sh
npm install
npm run check
npm test
```
