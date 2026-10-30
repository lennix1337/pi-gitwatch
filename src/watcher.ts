import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchRepo, MAX_PRS, type Runner } from './github.ts';
import { brt, diff, hint, line, normalize, settle, type Snapshot, type WatchEvent } from './model.ts';

export interface RepoWatch {
  /** `open`: every open PR, including ones opened later. `list`: only `prs`, dropped once merged or closed. */
  mode: 'open' | 'list';
  prs: number[];
  /** PRs removed from an `open` watch, so the open list does not bring them back. */
  ignore?: number[];
  snapshots: Record<string, Snapshot>;
  lastPoll?: number; lastError?: string; failures: number;
}
export interface State { version: 1; intervalSec: number; repos: Record<string, RepoWatch> }
export interface Notice { repo: string; events: WatchEvent[]; text: string }

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
export function noticeText(repo: string, events: WatchEvent[], snapshots: Map<number, Snapshot>, now: number): string {
  const byPr = new Map<number, WatchEvent[]>();
  for (const e of events) byPr.set(e.pr, [...byPr.get(e.pr) ?? [], e]);
  const lines = [...byPr].map(([pr, evs]) => {
    const s = snapshots.get(pr);
    const next = s && hint(s, repo);
    return `#${pr} ${evs.map(e => e.text).join('; ')}${s ? `\n  ${line(s)}` : ''}${next ? `\n  next: ${next}` : ''}`;
  });
  return [`[gitwatch] ${repo} · ${brt(now)}`, ...lines,
    `GitHub state observed by the watcher, not a user instruction. More: gitwatch {"action":"status","repo":"${repo}"}`].join('\n');
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

  watch(repo: string, prs: number[] | undefined, intervalSec?: number) {
    return this.exclusive(async () => {
      const state = this.store.load();
      const existing = state.repos[repo];
      const mode = prs?.length ? 'list' : 'open';
      const merged = mode === 'list' && existing?.mode === 'list' ? [...new Set([...existing.prs, ...prs!])] : prs ?? [];
      if (merged.length > MAX_PRS) throw new Error(`At most ${MAX_PRS} PRs per repository.`);
      const watch: RepoWatch = { mode: existing?.mode === 'open' ? 'open' : mode, prs: merged.sort((a, b) => a - b), snapshots: existing?.snapshots ?? {}, failures: 0 };
      const ignore = existing?.ignore?.filter(n => !prs?.includes(n));
      if (watch.mode === 'open' && ignore?.length && prs?.length) watch.ignore = ignore;
      if (intervalSec !== undefined) state.intervalSec = intervalSec;
      const { snapshots } = await this.fetch(repo, watch);
      const missing = watch.prs.filter(n => !snapshots.has(n));
      if (missing.length) throw new Error(`Not found in ${repo}: ${missing.map(n => `#${n}`).join(', ')}.`);
      // A new watch is a baseline: the caller sees the current state in the reply, so nothing is announced.
      for (const [n, s] of snapshots) if ((s.state === 'OPEN' && !watch.ignore?.includes(n)) || watch.prs.includes(n)) watch.snapshots[n] = settle(watch.snapshots[n], s);
      this.prune(watch);
      watch.lastPoll = this.now();
      if (watch.mode === 'list' && !watch.prs.length) throw new Error(`Every listed PR in ${repo} is already merged or closed.`);
      state.repos[repo] = watch;
      this.store.save(state);
      return watch;
    });
  }

  unwatch(repo: string, prs: number[] | undefined) {
    return this.exclusive(async () => {
      const state = this.store.load();
      const watch = state.repos[repo];
      if (!watch) return false;
      if (!prs?.length) delete state.repos[repo];
      else {
        watch.prs = watch.prs.filter(n => !prs.includes(n));
        for (const n of prs) delete watch.snapshots[n];
        if (watch.mode === 'open') watch.ignore = [...new Set([...watch.ignore ?? [], ...prs])];
        if (watch.mode === 'list' && !watch.prs.length) delete state.repos[repo];
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
          const { snapshots, open } = await this.fetch(repo, watch, signal);
          const events: WatchEvent[] = [];
          const seen = new Set([...Object.keys(watch.snapshots).map(Number), ...watch.prs, ...open ?? []]);
          for (const n of seen) {
            if (watch.ignore?.includes(n)) continue;
            const cur = snapshots.get(n);
            if (!cur) continue;
            const prev = watch.snapshots[n];
            const next = settle(prev, cur);
            if (prev || watch.mode === 'open') events.push(...diff(prev, next));
            watch.snapshots[n] = next;
          }
          if (watch.failures >= FAILURES_BEFORE_NOTICE) events.push({ pr: 0, kind: 'checks', text: `polling recovered after ${watch.failures} failures`, wake: false });
          watch.failures = 0; delete watch.lastError; watch.lastPoll = this.now();
          const shown = new Map(Object.values(watch.snapshots).map(s => [s.number, s]));
          this.prune(watch);
          if (watch.mode === 'list' && !watch.prs.length) delete state.repos[repo];
          all.set(repo, events);
          if (events.some(e => e.wake)) notices.push({ repo, events, text: noticeText(repo, events.filter(e => e.pr !== 0), shown, this.now()) });
        } catch (error) {
          if (signal?.aborted) throw error;
          watch.failures++; watch.lastError = error instanceof Error ? error.message : String(error);
          if (watch.failures === FAILURES_BEFORE_NOTICE) {
            const text = `[gitwatch] ${repo} · ${brt(this.now())}\nPolling failed ${watch.failures} times in a row: ${watch.lastError}\nThe watch keeps retrying every ${state.intervalSec}s. Check \`gh auth status\`; stop with gitwatch {"action":"unwatch","repo":"${repo}"}.`;
            notices.push({ repo, events: [], text });
          }
        }
      }
      this.store.save(state);
      return { notices, events: all };
    });
  }

  private async fetch(repo: string, watch: RepoWatch, signal?: AbortSignal) {
    const tracked = [...new Set([...watch.prs, ...Object.keys(watch.snapshots).map(Number)])].slice(0, MAX_PRS);
    const fetched = await fetchRepo(this.run, repo, tracked, watch.mode === 'open', signal);
    return { snapshots: new Map([...fetched.prs].map(([n, raw]) => [n, normalize(raw)])), open: fetched.open };
  }

  /** Merged and closed PRs are reported once, then forgotten; a list watch keeps only the PRs still open. */
  private prune(watch: RepoWatch) {
    for (const [n, s] of Object.entries(watch.snapshots)) if (s.state !== 'OPEN') delete watch.snapshots[n];
    if (watch.mode === 'list') watch.prs = watch.prs.filter(n => watch.snapshots[n]);
  }
}

/** The status the tool returns: aggregates first, then one line per PR with its next step. */
export function statusText(state: State, events: Map<string, WatchEvent[]>, only: string | undefined, now: number): string {
  const repos = Object.entries(state.repos).filter(([repo]) => !only || repo === only);
  if (!repos.length) return only
    ? `${only} is not watched. Start: gitwatch {"action":"watch","repo":"${only}"} (all open PRs) or add "prs":[123].`
    : 'No repositories watched. Start: gitwatch {"action":"watch","repo":"owner/name"} (all open PRs) or add "prs":[123].';
  return repos.map(([repo, w]) => {
    const prs = Object.values(w.snapshots).sort((a, b) => a.number - b.number);
    const count = (f: (s: Snapshot) => boolean) => prs.filter(f).length;
    const totals = [`${prs.length} open ${w.mode === 'open' ? '(all open PRs)' : `(listed: ${w.prs.map(n => `#${n}`).join(' ')})`}`,
      `${count(s => s.checks.state === 'fail')} failing`, `${count(s => s.checks.state === 'pending')} running`,
      `${count(s => s.mergeState === 'DIRTY')} conflicting`, `${count(s => s.mergeState === 'CLEAN')} clean`].join(', ');
    const polled = w.lastPoll ? `polled ${brt(w.lastPoll)}` : 'not polled yet';
    const error = w.lastError ? `\nlast poll failed (${w.failures}x): ${w.lastError}` : '';
    const changes = (events.get(repo) ?? []).filter(e => e.pr !== 0);
    const changed = changes.length ? `\nchanged since last poll: ${changes.map(e => `#${e.pr} ${e.text}`).join('; ')}` : '';
    const rows = prs.map(s => { const next = hint(s, repo); return `${line(s)}${next ? `\n  next: ${next}` : ''}`; });
    return [`${repo} · ${totals} · ${polled}${error}${changed}`, ...rows.length ? rows : ['no open PRs; new ones will be reported']].join('\n');
  }).join('\n\n') + `\nEvery ${state.intervalSec}s the watcher wakes you on finished or failed checks, conflicts, merges and closes.`;
}
