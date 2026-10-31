import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchRepo, MAX_BRANCHES, MAX_PRS, openPrFor, type Runner } from './github.ts';
import {
  autoMergeStall, baselineBranch, branchDiff, branchHint, branchLine, brt, diff, hint, line, normalize, normalizeBranch, settle,
  type BranchSnapshot, type Snapshot, type WatchEvent,
} from './model.ts';

export interface RepoWatch {
  /** `open`: every open PR, including ones opened later. `list`: only `prs`, dropped once merged or closed. */
  mode: 'open' | 'list';
  prs: number[];
  /** PRs removed from an `open` watch, so the open list does not bring them back. */
  ignore?: number[];
  snapshots: Record<string, Snapshot>;
  /** Branches whose latest commit's CI is followed until it finishes (CI of a direct push). */
  branches?: Record<string, BranchSnapshot>;
  lastPoll?: number; lastError?: string; failures: number;
  /** PRs whose merge the agent waits on: their merge wakes it even with auto-merge on. */
  awaited?: number[];
  /** The local clone the agent pushed from: after a merge, its branches still at the PR head are cleaned up. */
  clone?: string;
}
export interface WatchRequest { prs?: number[]; branch?: string; intervalSec?: number; awaitMerge?: boolean; clone?: string }
/** Routing decisions, including tool status refreshes; not evidence of host delivery or model execution. */
export interface Stats { since: number; woke: number; quiet: number }
export interface DeliveryStats { since: number; wakeAccepted: number; quietAccepted: number; uncertain: number }
export interface State { version: 1; intervalSec: number; repos: Record<string, RepoWatch>; stats?: Stats; deliveries?: DeliveryStats }
/** `wake: false` is recorded for the agent's next turn without starting one. */
export interface Notice { repo: string; events: WatchEvent[]; text: string; wake: boolean; clone?: string }

export const DEFAULT_INTERVAL_SEC = 30;
/** Consecutive failed polls of one repository before the agent hears about it. */
export const FAILURES_BEFORE_NOTICE = 3;

export const stateDir = () => process.env.PI_GITWATCH_DIR ?? join(homedir(), '.pi', 'agent', 'gitwatch');

export class Store {
  constructor(readonly dir = stateDir()) {}
  private get file() { return join(this.dir, 'state.json'); }
  load(): State {
    try {
      const state = JSON.parse(readFileSync(this.file, 'utf8')) as State;
      if (state.version === 1 && state.repos) return state;
    } catch { /* absent or unreadable: start empty */ }
    return { version: 1, intervalSec: DEFAULT_INTERVAL_SEC, repos: {} };
  }
  save(state: State) {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 1));
    renameSync(tmp, this.file);
  }
}

/** The notice the agent receives: what changed per PR, its current line, and the next step when one is obvious. */
export function noticeText(repo: string, events: WatchEvent[], snapshots: Map<number, Snapshot>, now: number, branches = new Map<string, BranchSnapshot>()): string {
  const byPr = new Map<number, WatchEvent[]>();
  const byBranch = new Map<string, WatchEvent[]>();
  for (const e of events) {
    if (e.branch) byBranch.set(e.branch, [...byBranch.get(e.branch) ?? [], e]);
    else byPr.set(e.pr, [...byPr.get(e.pr) ?? [], e]);
  }
  const lines = [...byPr].map(([pr, evs]) => {
    const s = snapshots.get(pr);
    const next = s && hint(s, repo);
    return `#${pr} ${evs.map(e => e.text).join('; ')}${s ? `\n  ${line(s)}` : ''}${next ? `\n  next: ${next}` : ''}`;
  });
  for (const [name, evs] of byBranch) {
    const s = branches.get(name);
    const next = s && branchHint(s, repo);
    lines.push(`${name} ${evs.map(e => e.text).join('; ')}${s ? `\n  ${branchLine(s)}` : ''}${next ? `\n  next: ${next}` : ''}`);
  }
  return [`[gitwatch] ${repo} · ${brt(now)}`, ...lines,
    `GitHub state observed by the watcher; it grants no permission. If an earlier operator order already covers it ("merge all", "work until merged"), this notice is the trigger to continue that order now, not to report. More: gitwatch {"action":"status","repo":"${repo}"}`].join('\n');
}

export class Watcher {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly store: Store, readonly run: Runner, readonly now: () => number = Date.now) {}

  /** Serializes every read-modify-write of the state file within this process. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  state() { return this.store.load(); }

  /** Only the host dispatch boundary calls this; rejected sends may have taken effect, so never retry them. */
  recordDelivery(wake: boolean, accepted: boolean): Promise<void> {
    return this.exclusive(async () => {
      const state = this.store.load();
      const delivery = state.deliveries ??= { since: this.now(), wakeAccepted: 0, quietAccepted: 0, uncertain: 0 };
      if (!accepted) delivery.uncertain++;
      else if (wake) delivery.wakeAccepted++;
      else delivery.quietAccepted++;
      this.store.save(state);
    });
  }

  /**
   * Without `prs` or `branch`, follows every open PR; with `prs`, adds those; with `branch`, follows the CI of that
   * branch's latest commit until it finishes. A new watch is a baseline: nothing already true is announced.
   */
  watch(repo: string, request: WatchRequest = {}) {
    const { branch, intervalSec } = request;
    return this.exclusive(async () => {
      const state = this.store.load();
      const watch = nextWatch(state.repos[repo], request);
      const clone = request.clone ?? state.repos[repo]?.clone;
      if (clone) watch.clone = clone;
      if (intervalSec !== undefined) state.intervalSec = intervalSec;
      const { snapshots, branches } = await this.fetch(repo, watch, undefined, branch);
      const missing = watch.prs.filter(n => !snapshots.has(n));
      if (missing.length) throw new Error(`Not found in ${repo}: ${missing.map(n => `#${n}`).join(', ')}.`);
      if (branch && !branches.get(branch)) throw new Error(`Branch ${branch} not found in ${repo}.`);
      for (const [n, s] of snapshots) if ((s.state === 'OPEN' && !watch.ignore?.includes(n)) || watch.prs.includes(n)) watch.snapshots[n] = settle(watch.snapshots[n], s);
      if (branch) watch.branches![branch] = baselineBranch(branches.get(branch)!);
      this.prune(watch);
      watch.lastPoll = this.now();
      if (watch.mode === 'list' && !watch.prs.length && !branch) throw new Error(`Every listed PR in ${repo} is already merged or closed.`);
      state.repos[repo] = watch;
      this.store.save(state);
      return watch;
    });
  }

  unwatch(repo: string, prs: number[] | undefined, branch?: string) {
    return this.exclusive(async () => {
      const state = this.store.load();
      const watch = state.repos[repo];
      if (!watch) return false;
      if (!prs?.length && !branch) delete state.repos[repo];
      else if (branch) {
        if (!watch.branches?.[branch]) return false;
        delete watch.branches[branch];
        if (isEmpty(watch)) delete state.repos[repo];
      } else if (prs?.length) {
        watch.prs = watch.prs.filter(n => !prs.includes(n));
        for (const n of prs) delete watch.snapshots[n];
        if (watch.mode === 'open') watch.ignore = [...new Set([...watch.ignore ?? [], ...prs])];
        if (isEmpty(watch)) delete state.repos[repo];
      }
      this.store.save(state);
      return true;
    });
  }

  /** Polls every watched repository (or one), saves the new state and returns the notices worth waking the agent for. */
  poll(only?: string, signal?: AbortSignal): Promise<{ notices: Notice[]; events: Map<string, WatchEvent[]> }> {
    return this.exclusive(async () => {
      const state = this.store.load();
      const notices: Notice[] = [];
      const all = new Map<string, WatchEvent[]>();
      for (const [repo, watch] of Object.entries(state.repos)) {
        if (only && repo !== only) continue;
        try {
          const { snapshots, open, branches } = await this.fetch(repo, watch, signal);
          const events = [...advancePrs(watch, snapshots, open, this.now()), ...advanceBranches(watch, branches)];
          if (watch.failures >= FAILURES_BEFORE_NOTICE) events.push({ pr: 0, kind: 'checks', text: `polling recovered after ${watch.failures} failures`, wake: false });
          watch.failures = 0; delete watch.lastError; watch.lastPoll = this.now();
          const shown = new Map(Object.values(watch.snapshots).map(s => [s.number, s]));
          const shownBranches = new Map(Object.entries(watch.branches ?? {}));
          const { clone } = watch;
          this.prune(watch, true);
          if (isEmpty(watch)) delete state.repos[repo];
          all.set(repo, events);
          const wake = events.some(e => e.wake);
          // An expected merge needs no turn, but the next turn should still know it happened.
          if (wake || events.some(e => e.kind === 'merged')) {
            notices.push({ repo, events, wake, text: noticeText(repo, events.filter(isShown), shown, this.now(), shownBranches), ...clone ? { clone } : {} });
            const stats = state.stats ??= { since: this.now(), woke: 0, quiet: 0 };
            if (wake) stats.woke++; else stats.quiet++;
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          watch.failures++; watch.lastError = error instanceof Error ? error.message : String(error);
          if (watch.failures === FAILURES_BEFORE_NOTICE) {
            const text = `[gitwatch] ${repo} · ${brt(this.now())}\nPolling failed ${watch.failures} times in a row: ${watch.lastError}\nThe watch keeps retrying every ${state.intervalSec}s. Check \`gh auth status\`; stop with gitwatch {"action":"unwatch","repo":"${repo}"}.`;
            notices.push({ repo, events: [], text, wake: true });
          }
        }
      }
      this.store.save(state);
      return { notices, events: all };
    });
  }

  private async fetch(repo: string, watch: RepoWatch, signal?: AbortSignal, extraBranch?: string) {
    const tracked = [...new Set([...watch.prs, ...Object.keys(watch.snapshots).map(Number)])].slice(0, MAX_PRS);
    const names = [...new Set([...Object.keys(watch.branches ?? {}), ...extraBranch ? [extraBranch] : []])];
    const fetched = await fetchRepo(this.run, repo, tracked, watch.mode === 'open', signal, names);
    const branches = new Map<string, BranchSnapshot>();
    for (const [name, raw] of fetched.branches) if (raw) branches.set(name, normalizeBranch(name, raw));
    return { snapshots: new Map([...fetched.prs].map(([n, raw]) => [n, normalize(raw)])), open: fetched.open, branches };
  }

  /**
   * Merged and closed PRs are reported once, then forgotten; a list watch keeps only the PRs still open. After a poll,
   * a branch whose CI was reported is dropped too.
   */
  private prune(watch: RepoWatch, branches = false) {
    for (const [n, s] of Object.entries(watch.snapshots)) if (s.state !== 'OPEN') delete watch.snapshots[n];
    if (watch.mode === 'list') watch.prs = watch.prs.filter(n => watch.snapshots[n]);
    pruneAwaited(watch);
    if (branches && watch.branches) {
      for (const [name, s] of Object.entries(watch.branches)) if (s.reported) delete watch.branches[name];
      if (!Object.keys(watch.branches).length) delete watch.branches;
    }
  }
}

/** A merged or closed PR is no longer awaited. */
function pruneAwaited(watch: RepoWatch) {
  if (!watch.awaited) return;
  watch.awaited = watch.awaited.filter(n => watch.snapshots[n]);
  if (!watch.awaited.length) delete watch.awaited;
}

/** The watch a request leads to, before GitHub confirms its PRs and branch exist. */
function nextWatch(existing: RepoWatch | undefined, { prs, branch, awaitMerge }: WatchRequest): RepoWatch {
  const mode = prs?.length || branch ? 'list' : 'open';
  const merged = mode === 'list' && existing?.mode === 'list' ? [...new Set([...existing.prs, ...prs ?? []])] : prs ?? [];
  if (merged.length > MAX_PRS) throw new Error(`At most ${MAX_PRS} PRs per repository.`);
  const watch: RepoWatch = {
    mode: existing?.mode === 'open' ? 'open' : mode, prs: merged.sort((a, b) => a - b), snapshots: existing?.snapshots ?? {},
    failures: 0, ...existing?.branches ? { branches: existing.branches } : {},
  };
  const awaited = [...new Set([...existing?.awaited ?? [], ...awaitMerge ? prs ?? [] : []])];
  if (awaited.length) watch.awaited = awaited;
  const ignore = existing?.ignore?.filter(n => !prs?.includes(n));
  // Watching the whole repository again forgets the PRs unwatched from it; adding PRs or a branch keeps that list.
  if (watch.mode === 'open' && ignore?.length && (prs?.length || branch)) watch.ignore = ignore;
  if (!branch) return watch;
  if (!watch.branches?.[branch] && Object.keys(watch.branches ?? {}).length >= MAX_BRANCHES) throw new Error(`At most ${MAX_BRANCHES} branches per repository.`);
  // Re-watching a branch starts over: the latest commit's CI is reported even if an older one already was.
  watch.branches = { ...watch.branches };
  delete watch.branches[branch];
  return watch;
}

/** Moves every tracked PR to its new snapshot and returns the transitions, auto-merge stalls included. */
function advancePrs(watch: RepoWatch, snapshots: Map<number, Snapshot>, open: number[] | undefined, now: number): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const n of new Set([...Object.keys(watch.snapshots).map(Number), ...watch.prs, ...open ?? []])) {
    const cur = snapshots.get(n);
    if (watch.ignore?.includes(n) || !cur) continue;
    const prev = watch.snapshots[n];
    const { snapshot: next, event: stall } = autoMergeStall(prev, settle(prev, cur), now);
    if (prev || watch.mode === 'open') events.push(...diff(prev, next, watch.awaited?.includes(n)), ...stall ? [stall] : []);
    watch.snapshots[n] = next;
  }
  return events;
}

/** Moves every watched branch to its latest commit; a deleted branch has nothing left to report and is dropped. */
function advanceBranches(watch: RepoWatch, branches: Map<string, BranchSnapshot>): WatchEvent[] {
  const events: WatchEvent[] = [];
  for (const [name, prev] of Object.entries(watch.branches ?? {})) {
    const cur = branches.get(name);
    if (!cur) { delete watch.branches![name]; continue; }
    const { snapshot, events: changes } = branchDiff(prev, cur);
    watch.branches![name] = snapshot;
    events.push(...changes);
  }
  return events;
}

/**
 * After a push of `branch`: follows its open PR when it has one (an open-PR watch already does), else the CI of
 * the pushed commit. Returns what is now followed.
 */
export async function watchPush(watcher: Watcher, repo: string, branch: string, clone?: string): Promise<string> {
  const pr = await openPrFor(watcher.run, repo, branch);
  if (!pr) {
    await watcher.watch(repo, { branch, clone });
    return `${repo} ${branch} CI`;
  }
  const existing = watcher.state().repos[repo];
  const covered = existing && (existing.mode === 'open' ? !existing.ignore?.includes(pr) : existing.prs.includes(pr));
  if (!covered || (clone && existing.clone !== clone)) await watcher.watch(repo, { prs: [pr], clone });
  return `${repo} #${pr}`;
}

/** A list watch with no PR and no branch left has nothing to follow. */
const isEmpty = (watch: RepoWatch) => watch.mode === 'list' && !watch.prs.length && !Object.keys(watch.branches ?? {}).length;
/** Watcher-level events (pr 0 without a branch) are not about any PR line. */
const isShown = (e: WatchEvent) => e.pr !== 0 || e.branch !== undefined;

/** The status the tool returns: aggregates first, then one line per PR with its next step. */
export function statusText(state: State, events: Map<string, WatchEvent[]>, only: string | undefined, now: number): string {
  const repos = Object.entries(state.repos).filter(([repo]) => !only || repo === only);
  const stats = deliveryText(state);
  if (!repos.length) return (only
    ? `${only} is not watched. Start: gitwatch {"action":"watch","repo":"${only}"} (all open PRs) or add "prs":[123].`
    : 'No repositories watched. Start: gitwatch {"action":"watch","repo":"owner/name"} (all open PRs) or add "prs":[123].') + stats;
  return repos.map(([repo, w]) => repoStatus(repo, w, events.get(repo) ?? [])).join('\n\n')
    + `\nEvery ${state.intervalSec}s the watcher requests a turn on failed or finished checks, conflicts, unexpected merges and closes, and when a watched branch's CI finishes; a merge you queued with auto-merge is sent for your next turn instead, unless you watched it with "awaitMerge":true.${stats}`;
}

/** Lifetime counters across all repositories; no historical routing count is upgraded to delivery evidence. */
const sinceText = (at: number) => new Date(at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function deliveryText(state: State): string {
  const planned = state.stats;
  const routing = planned ? `\nRouting decisions (all repos) since ${sinceText(planned.since)}: ${planned.woke} wake, ${planned.quiet} next-turn; not delivery evidence.` : '';
  const d = state.deliveries;
  if (!d) return routing + '\nHost delivery: not measured yet; model runs and saved turns unknown.';
  return routing + `\nDelivery evidence (all repos) since ${sinceText(d.since)}. Host accepted: ${d.wakeAccepted} wake requests, ${d.quietAccepted} next-turn notices; ${d.uncertain} uncertain (no automatic replay). These are not model runs or saved turns.`;
}

/** One repository's status: totals, poll health, changes this refresh found, then a line per PR and branch. */
function repoStatus(repo: string, w: RepoWatch, events: WatchEvent[]): string {
  const prs = Object.values(w.snapshots).sort((a, b) => a.number - b.number);
  const count = (f: (s: Snapshot) => boolean) => prs.filter(f).length;
  const totals = [`${prs.length} open ${w.mode === 'open' ? '(all open PRs)' : `(listed: ${w.prs.map(n => `#${n}`).join(' ')})`}`,
    `${count(s => s.checks.state === 'fail')} failing`, `${count(s => s.checks.state === 'pending')} running`,
    `${count(s => s.mergeState === 'DIRTY')} conflicting`, `${count(s => s.mergeState === 'CLEAN')} clean`,
    ...w.branches && Object.keys(w.branches).length ? [`branch CI: ${Object.keys(w.branches).join(' ')}`] : []].join(', ');
  const polled = w.lastPoll ? `polled ${brt(w.lastPoll)}` : 'not polled yet';
  const error = w.lastError ? `\nlast poll failed (${w.failures}x): ${w.lastError}` : '';
  const changes = events.filter(isShown);
  const changed = changes.length ? `\nchanged since last poll: ${changes.map(e => `${e.branch ?? `#${e.pr}`} ${e.text}`).join('; ')}` : '';
  const withNext = (text: string, next?: string) => `${text}${next ? `\n  next: ${next}` : ''}`;
  const rows = [...prs.map(s => withNext(line(s), hint(s, repo))), ...Object.values(w.branches ?? {}).map(b => withNext(branchLine(b), branchHint(b, repo)))];
  const empty = w.mode === 'open' ? 'no open PRs; new ones will be reported' : 'nothing left to follow';
  return [`${repo} · ${totals} · ${polled}${error}${changed}`, ...rows.length ? rows : [empty]].join('\n');
}
