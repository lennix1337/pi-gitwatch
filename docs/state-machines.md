# Implicit state machines in pi-gitwatch

Catalog made on `origin/main` (9320687). Line numbers are for the files after this PR.
`fix/notice-continues-standing-order` is already merged into `origin/main` (#7): it only changed notice wording, no machine.

Severity: P1 wrong behaviour with real impact, P2 wrong behaviour in a reachable situation, P3 latent or cosmetic.

## 1. Poll loop (`src/index.ts:78-130`)

- **States:** `stopped`, `waiting` (timer armed), `polling` (inside a tick). Before: `running: boolean` + `timer: unknown`; "polling" had no representation at all.
- **Events:** `session_start` (tui), the `watch` tool call, timer fired, `session_shutdown`.
- **Transitions:** `stopped -> waiting` (start), `waiting -> polling` (timer), `polling -> waiting` (tick end, same epoch), `waiting|polling -> stopped` (stop).
- **Lives in:** closure memory of the extension instance. Readers: `tick`, `start`, `stop`, `tool_result` hook (auto-watch only while not stopped).
- **Invariants:** one timer chain per instance; no delivery or reschedule after a stop; only an interactive (tui) session polls.
- **Findings**
  - **GW-1 (P2, fixed).** `session_shutdown` followed by `session_start` while a tick was in flight: `stop()` set `running=false`, `start()` set `running=true` and armed a new timer, then the old tick finished, saw `running` true and armed a second one, overwriting `timer`. Two poll chains forever (double `gh` traffic, the first one uncancellable). Fix: `Loop` union + `epoch` bumped on stop; a tick of an older epoch neither delivers nor reschedules; every move goes through `move()` against `LOOP_MOVES`, an unlisted move is ignored and warned once. Test: `a session restart during a poll leaves exactly one poll loop`.
  - **GW-2 (P2, fixed).** `watch` tool called `start()` in any session mode, so a subagent or one-shot run that merely called the tool started its own loop and, since `running` was true, its own `git push` auto-watch, against AGENTS.md ("never make subagents or one-shot runs poll"; "a child's push is its parent's to watch"). The lease only masked it while an interactive poller was alive. Fix: `interactive` is set at `session_start` and `start()` is a no-op otherwise; the watch is still recorded in the state file for the interactive poller. Test: `a watch made from a subagent or one-shot session does not start a poll loop there`.
  - GW-3 (P3, catalogued). `poll()` saves the advanced state before notices are delivered (`index.ts` tick). If the process stops between save and delivery, or the loop is stopped mid-delivery (`mine !== epoch` break), those notices are lost (at-most-once). This is the documented "no automatic replay" policy (rejected sends may have taken effect); fixing it needs a persisted outbox, a design decision, so left as is.
  - GW-4 (P3, catalogued). The loop keeps ticking forever when there are no watches (cheap: one file read per interval). Not a leak: the timer is `unref`ed and cancelled on stop.

## 2. Poller lease (`src/index.ts:14-30`)

- **States (file `lease.json`):** absent, held by live pid with fresh `at`, held but stale or dead.
- **Transitions:** `acquire(now, staleMs)` takes it if absent / own / stale / holder dead; `release()` removes it only if it is ours.
- **Findings**
  - GW-5 (P3, catalogued). `acquire` is read-then-write, not atomic: two processes starting in the same millisecond can both believe they hold it; the loser notices on its next tick (`held.pid !== this.pid`). One duplicate poll is possible; both would load the same state and emit the same notice. Window is milliseconds and needs two interactive sessions at once.
  - GW-6 (P3, catalogued). `lease.json` is parsed without validation; a corrupt file throws inside `try` and the lease is taken (fail-open), which is the desired outcome.

## 3. Watch registry and request lifecycle (`src/watcher.ts`: `RepoWatch`, `nextWatch`, `watch`, `unwatch`, `prune`)

- **States per repo:** `mode: 'open' | 'list'` plus `prs`, `ignore`, `awaited`, `branches`, `snapshots`, `clone`. A list watch with no PR and no branch is "empty" and removed (`isEmpty`).
- **Transitions:** `watch` (list->list merges PRs, anything->open when no `prs`/`branch`, open stays open), `unwatch` (repo / PRs / branch), `poll` pruning (merged or closed PRs forgotten after one report, reported branches dropped, awaited pruned with their PR).
- **Lives in:** `state.json` under `PI_GITWATCH_DIR` (default `~/.pi/agent/gitwatch`), written atomically (tmp + rename).
- **Serialization:** `Watcher.exclusive` chains every read-modify-write inside one process.
- **Findings**
  - **GW-7 (P2, fixed).** `Store.load` trusted any `{version: 1, repos}` file. A watch lacking `failures` (older file, hand edit) made `failures++` produce `NaN`, and `NaN === FAILURES_BEFORE_NOTICE` is never true: polling failures were never announced. Missing `snapshots`/`prs` made every poll throw inside the per-repo `try`, counted as a polling failure forever. Fix: `repair()` on load drops watches with an unknown `mode` and gives missing fields their empty value. Test: `a state file with a missing or unknown watch shape is repaired on load so polling failures still reach the agent`.
  - GW-8 (P3, catalogued). `exclusive` is per process. `watch`/`unwatch` from a second process (a subagent calling the tool) during another process's `poll` (load, seconds of `gh` I/O, save) can be overwritten by that poll's save. Needs a cross-process file lock; the window requires a concurrent subagent watch during a poll, so left for a decision.
  - GW-9 (P3, catalogued). `Store.load` returns an empty state for an unreadable file and the next `save` overwrites it: a corrupt `state.json` silently forgets all watches.
  - GW-10 (P3, catalogued). `ignore` only grows (PRs unwatched from an open watch); bounded in practice by the repository's PR count.

## 4. Poll health per repository (`src/watcher.ts:166-205`)

- **States:** healthy (`failures 0`), failing (`1..2`, silent), notified (`3`), still failing (`>3`, silent), recovered (back to 0).
- **Transitions:** failed poll `failures++`, announced exactly when it reaches `FAILURES_BEFORE_NOTICE`; a good poll resets to 0 and clears `lastError`.
- **Findings**
  - GW-11 (P3, catalogued). The "polling recovered after N failures" event is `pr: 0`, `wake: false`; the notice path filters it with `isShown` and only creates a notice when another event wakes. The agent that was told "polling failed 3 times" is never told it recovered, and `status` does not print it. Dead transition; adding a notice changes what wakes the agent, so left for a product decision.
  - GW-12 (P3, catalogued). An exception thrown while advancing snapshots (after `fetch`) is counted as a polling failure, and the watch may be left partially advanced because `advancePrs` mutates `watch.snapshots` as it goes.

## 5. PR snapshot transitions (`src/model.ts:100-134`, `diff`)

- **State:** `Snapshot` (`state` OPEN/MERGED/CLOSED, `checks.state`, `mergeState`, `draft`, `review`, `head`, `auto`). Explicit and pure: `diff(prev, cur, awaited)` returns the events and which of them wake. Covered by `test/model.test.ts`.
- **Note:** `settle` keeps the last known `mergeState` when GitHub reports `UNKNOWN` on the same head (flap suppression). Merged/closed are reported once then pruned, so reopen after pruning is seen as a new PR.
- **Findings:** none. Cataloged as already explicit and correct.

## 6. Auto-merge stall (`src/model.ts:136-150`)

- **States (`passedAt`, `stallReported`):** not applicable (not open / no auto-merge / checks not passing) -> timing (`passedAt` set) -> reported (`stallReported`). Resets to not applicable when checks leave `pass`, auto-merge turns off or the head changes.
- **Findings:** none. Two optional fields encode three states, but only `autoMergeStall` writes them and `hint` reads one; pure and tested.

## 7. Branch CI watch (`src/model.ts:152-170`, `advanceBranches`, `prune`)

- **States (`BranchSnapshot.reported`):** following -> reported (CI final: pass or fail) -> pruned on the next `poll` prune; a new head resets `reported`; a deleted branch is dropped.
- **Baseline:** `baselineBranch` marks CI already final as reported, so nothing finished before the watch is announced.
- **Findings:** none. One flag, one writer pair (`branchDiff`, `baselineBranch`), pruned in a single place.

## 8. Notice delivery and dedupe (`src/index.ts:94-107`, `recordDelivery`)

- **Notice routing:** `wake` true -> `steer` with `triggerTurn`; false -> `triggerTurn: false` (appended at once, no turn). Outcome per notice: accepted or uncertain (rejected/thrown), counted in `deliveries`, never replayed.
- **Dedupe:** achieved by state, not by a sent-set: an event exists only on the transition that changed the snapshot, and the snapshot is saved in the same `poll` (`stallReported`, `reported`, pruning of merged PRs). `status` refresh consumes the same transitions, so it shows them and the loop never repeats them.
- **Findings:** only GW-3 (delivery after the state advance), described under the poll loop.

## 9. Local cleanup after merge (`src/cleanup.ts`)

Stateless: per merged event, lists branches at the merged head and removes the safe ones. No machine.

## 10. Autowatch push/PR detection (`src/autowatch.ts`)

Stateless parsing of a shell command (`cd`/`git -C` directory tracking is a local variable inside one call). No machine.

## Summary

| machine | states | explicitness before | after | findings |
| --- | --- | --- | --- | --- |
| Poll loop | stopped / waiting / polling | `running` + `timer`, polling implicit | union + epoch + move table | GW-1 P2 fixed, GW-2 P2 fixed, GW-3 P3, GW-4 P3 |
| Poller lease | absent / held / stale | file protocol | unchanged | GW-5 P3, GW-6 P3 |
| Watch registry and persisted state | open / list / empty | `mode` field, unvalidated file | `repair()` on load | GW-7 P2 fixed, GW-8 P3, GW-9 P3, GW-10 P3 |
| Poll health | healthy / failing / notified / recovered | `failures` counter | unchanged | GW-11 P3, GW-12 P3 |
| PR snapshot transitions | open / merged / closed x checks x mergeState | explicit, pure | unchanged | none |
| Auto-merge stall | n/a / timing / reported | two optional fields, one writer | unchanged | none |
| Branch CI watch | following / reported / pruned | one flag, pure | unchanged | none |
| Notice delivery | wake / next-turn x accepted / uncertain | explicit counters | unchanged | GW-3 (P3) |
| Cleanup, autowatch parsing | stateless | n/a | n/a | none |
