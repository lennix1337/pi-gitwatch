# pi-gitwatch

Pi extension that watches GitHub pull requests and wakes the agent when one needs attention, so nobody has to ask "did CI finish?".

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
| `watch` | `repo`, `prs?`, `intervalSec?` | Without `prs`, follows every open PR (new ones too); with `prs`, only those. Fails before saving if a PR does not exist. |
| `unwatch` | `repo`, `prs?` | Stops following PRs, or the repository. |

Wake events: checks passed/failed, merge conflict, BEHIND with checks done, CLEAN without auto-merge, approved/changes requested, merged, closed, 3 consecutive poll failures. Other changes (push, checks starting, new PR, draft/auto-merge toggles) are included in the next notice and in `status`. One verdict per check name, so a cancelled duplicate next to a passing twin is not a failure. GitHub's transient `UNKNOWN` mergeability keeps the last known state.

## Behavior

- One GraphQL request per repository per poll through the authenticated `gh` CLI; at most 50 PRs per repository.
- Only an interactive (TUI) Pi polls, and a lease file keeps a single poller per machine; subagents and `pi -p` runs never poll.
- Notices are custom messages (`customType: "gitwatch"`) sent with `triggerTurn` and `deliverAs: "steer"`.
- Read-only on GitHub. State: `~/.pi/agent/gitwatch/state.json` (override with `PI_GITWATCH_DIR`).

## Development

```sh
npm install
npm run check
npm test
```
