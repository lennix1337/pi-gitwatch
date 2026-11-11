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
| `watch` | `repo`, `prs?` or `branch?`, `intervalSec?`, `subscriber?` | Without `prs`, follows every open PR (new ones too); with `prs`, only those; with `branch`, the CI of its latest commit until it finishes. Fails before saving if a PR or branch does not exist. With `subscriber` (a label such as `worker-1`), the notices of those PRs or that branch go to a subscriber on the Pi event bus (`gitwatch:subscriber-notice`, accept it synchronously); when none accepts one, it comes back to this session, marked. Without `subscriber`, nothing changes. |
| `unwatch` | `repo`, `prs?` or `branch?` | Stops following PRs, a branch, or the repository. |

Wake events: checks failed, checks passed without auto-merge, merge conflict, BEHIND with checks done, CLEAN without auto-merge, auto-merge still open 10 min after checks passed, approved/changes requested, a merge (an auto-merge whose cleanup left nothing is only reported, see below), closed, a watched branch's CI finishing, 3 consecutive poll failures. A network outage gives one polling-failure notice that names every affected repository, and one recovery notice, not one per repository. Every notice ends by saying it is an automated notice, not the operator's words, and that it neither grants nor withdraws permission: the next step follows the agent's standing rules or an earlier order. When that stall comes from a check the base requires (branch protection or a ruleset) that never reported on the head, as when GitHub skips creating a workflow's final job, the notice names the check and the `gh run rerun <id>` that brings it back. A failing check's notice names its Actions run and the `gh run view <id> --log-failed` command, and links up to three failing jobs inline (more spill to `gh pr checks` or `gh run list`). Long titles are cut with the PR URL; the head branch is shown when known. A merge you queued with auto-merge is the expected outcome; when its local cleanup also left nothing for the agent to do, the merged notice (with its cleanup lines) is delivered with the next turn, without `triggerTurn`. It still wakes the agent when the cleanup or the fast-forward left or failed something (a kept branch or worktree, a skipped fast-forward, a clone that no longer exists), when no clone is known (nothing was cleaned), and for any merge nobody here queued. A loaded Pi package (`reload needed`) does not wake by itself: the line rides along in the quiet notice. Every event is routed before any turn is requested, with no model call: `respond` wakes the session; `candidate` (checks starting, a new head, a draft or auto-merge toggle, a repeated confirmation on a head already announced, a local cleanup) waits in a batch that the next notice carries once, and goes out quietly after 30 minutes; `ignore` is counted and never sent, for a merge this session made with `gh pr merge` itself (not `--auto`). A failure, conflict, review, stall, close or merge nobody here made always responds. Candidates are held at most 40 per target; older ones are counted (`N earlier omitted`). One verdict per check name, so a cancelled duplicate next to a passing twin is not a failure. GitHub's transient `UNKNOWN` mergeability keeps the last known state.

After a PR you pushed from this machine merges, its local branches that still point exactly at the merged head are deleted, and a linked worktree holding one is removed with plain `git worktree remove` (never `--force`): a worktree with uncommitted files, a branch checked out in the main worktree, a branch with later commits and `main`/`master`/`trunk`/`develop` are kept. Cleanup runs Git from the main worktree and prunes worktrees whose folder is already gone. Then the main checkout (the repository's first worktree, even when the push came from a linked one) is fast-forwarded, only when it is on the default branch with no uncommitted change to tracked files and a fast-forward is possible; it is never stashed, reset or merged, and a skip names why (dirty, diverged, another branch, detached HEAD, no upstream). When the main checkout is a Pi package listed in `~/.pi/agent/settings.json` `packages`, a `reload needed` line says the merge is not live yet (information only: it does not make the notice wake). A clone comes from the watch call, from the `clone` field of a follow request file, or, when a script names none, from the loaded Pi package whose `origin` is the repository. The notice ends with a `Local cleanup in <clone>:` line saying what was removed or kept.

## Behavior

- One GraphQL request per repository per poll through the authenticated `gh` CLI; at most 50 PRs per repository.
- Only an interactive (TUI) Pi polls, and a lease file keeps a single poller per machine; subagents and `pi -p` runs never poll.
- Notices are custom messages (`customType: "gitwatch"`) sent with `triggerTurn` and `deliverAs: "steer"`.
- A notice that does not wake the agent (a quiet merge, a held batch going out) is a visible message appended to the session at once with `triggerTurn: false`: no model call, no held copy, and each one shows when it happens. It is never sent with `deliverAs: "nextTurn"`, which Pi holds in memory until the operator writes again and then renders; and never as a UI notification, which Pi overwrites when several arrive in a row.
- Auto-follow: after a successful bash command with `gh pr create` or `git push` (tags, deletions and dry runs excluded; the command is split on `&&`, `||`, `;`, `|` and newlines outside quotes, and `~`/`$HOME` in a `cd` resolve to the home folder), the polling session follows the created PR, the pushed branch's open PR, or the pushed commit's CI, and appends `[gitwatch] now following ...` to the command output.
- Read-only on GitHub. State: `~/.pi/agent/gitwatch/state.json` (override with `PI_GITWATCH_DIR`).

## Live state for other extensions

Stable contract on `pi.events` (in-process; a field may be added, never renamed; a breaking change gets a `:v2` channel). The interactive session that polls emits:

- `gitwatch:state:v1`, after every poll or status refresh, built from data the poll already fetched (no extra `gh` call): `{ version: 1, polledAt, repos: [{ repo, mode: "open" | "list", lastError?, prs: [{ repo, number, title, url, head /* 7 chars */, mergeState, autoMerge, checks: { pass, fail, pending }, pendingSince /* ms epoch of the oldest running check, null if none or unknown */, next /* the notice's "next:" step, or null */ }], branches: [{ repo, branch, head, checks, pendingSince }] }] }`. Merged and closed PRs are gone from the list once reported.
- `gitwatch:notice:v1`, for each delivered notice: `{ repo, wake, text, at, events, subscriber? }`.

A consumer that loads later emits `gitwatch:state:request:v1`; the answer is the last `gitwatch:state:v1` again (nothing before the first poll).

## Delivery evidence

`status` separates routing decisions from host delivery. Routing includes manual status refreshes; it is not evidence of a wake. Routing by event counts every routed event since its start: `respond`, `candidate` and `ignore`; status refreshes count there too, and `ignore` counts only merges this session made itself. Delivery counters start only when the Pi `sendMessage` call returns or resolves successfully: wake requests, next-turn notices and uncertain dispatches. A rejection can occur after an effect, so it produces a local warning and is never automatically replayed. Later notices still proceed.

Counters persist in `state.json`, remain visible when the last watch ends, and cover **all repositories since the displayed Brasília date/time**, even when filtering status by repository. Legacy routing counts are not promoted to delivery counts. They count notices (which may bundle several events), not model runs, saved turns, weekly rates, latency or validated deliveries of work. A fresh/legacy profile reports delivery as unmeasured until a dispatch completes. The offline `delivery` check exercises the actual extension factory and host callback boundary, not the live model. `delivery-mutations` proves the assertions reject unawaited sends, missing receipts and false success on rejection; CI runs these mutants on both platforms.

## Development

```sh
npm install
npm run verify   # tsc --noEmit, then the offline suite (fake gh, no network); CI runs the same command
node test/delivery-mutations.mjs
```

State machines of the watcher and the routing are drawn in [docs/state-machines.md](docs/state-machines.md). The packaged `pi-gitwatch` skill tells the agent when to watch and how to read a notice.
