import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CleanupLine } from './cleanup.ts';
import { fetchRepo, fetchSteps, lookupPush, MAX_BRANCHES, MAX_PRS, type Runner } from './github.ts';
import {
  autoMergeStall, baselineBranch, branchDiff, branchHint, branchLine, brt, diff, failedJobIds, headRollup, hint, jobsText, line, normalize, normalizeBranch, settle, stepsUnread,
  type Announced, type BranchSnapshot, type Checks, type RawCommit, type Snapshot, type Steps, type WatchEvent,
} from './model.ts';
import { announce, handledMerge, routeEvent, type Decision } from './route.ts';

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
  /** The local clone the agent pushed from: after a merge, its branches still at the PR head are cleaned up. */
  clone?: string;
  /** PRs this session merged itself (`gh pr merge` without --auto): their merge is already known to the agent. */
  ownMerges?: number[];
  /** Subscriber labels by `pr:<n>` or `branch:<name>`: their notices go to that subscriber instead of this session. */
  subscribers?: Record<string, string>;
  /** Candidates waiting for the next notice, per target: `main`, or `sub:<label>` for a subscriber. */
  held?: Record<string, Held>;
}
/** Candidate events held for one target: when the oldest was held, and how many older ones the cap dropped. */
export interface Held { since: number; items: WatchEvent[]; omitted?: number }
export interface WatchRequest {
  prs?: number[]; branch?: string; intervalSec?: number; clone?: string;
  /** A subscriber label that takes the notices of these PRs or this branch. */
  subscriber?: string;
  /** The branch head the caller just read (null: the branch does not exist). Used instead of a request when nothing else is tracked. */
  head?: RawCommit | null;
}
/** Routing decisions, including tool status refreshes; not evidence of host delivery or model execution. */
export interface Stats { since: number; woke: number; quiet: number }
/** Every event the watcher routed since `since`, by route (status refreshes included). */
export interface Routes { since: number; respond: number; candidate: number; ignore: number }
export interface DeliveryStats {
  since: number; wakeAccepted: number; quietAccepted: number; uncertain: number;
  subscriberClaimed?: number; subscriberFallback?: number;
}
export interface State { version: 1; intervalSec: number; repos: Record<string, RepoWatch>; stats?: Stats; deliveries?: DeliveryStats; routes?: Routes }
/** `wake: false` is recorded for the agent's next turn without starting one. `subscriber` names who takes it, if not this session. */
export interface Notice { repo: string; events: WatchEvent[]; text: string; wake: boolean; clone?: string; subscriber?: string }
export interface PollOptions {
  /** `false`: the caller shows the changes itself (status), so nothing is held or returned as a notice. */
  deliver?: boolean;
  /** Local cleanup of the merged PRs in the clone the agent pushed from; its results are reported with the merge. */
  cleanup?: (notice: { clone: string; events: WatchEvent[] }) => Promise<CleanupLine[]>;
}

export const DEFAULT_INTERVAL_SEC = 30;
/** Consecutive failed polls of one repository before the agent hears about it. */
export const FAILURES_BEFORE_NOTICE = 3;
/** A network error (timeout, reset, DNS) is usually a blip that heals itself: it needs this many failures (~10 min at 30 s) before it wakes the agent. */
export const NETWORK_FAILURES_BEFORE_NOTICE = 20;
const NETWORK_ERROR = /connectex|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|timed out|i\/o timeout|network is unreachable/i;
const noticeAfter = (error?: string) => error && NETWORK_ERROR.test(error) ? NETWORK_FAILURES_BEFORE_NOTICE : FAILURES_BEFORE_NOTICE;
/** A candidate waits for a delivery at most this long, then goes out as a quiet notice (no model turn). */
export const HELD_MAX_AGE_MS = 30 * 60_000;
/** Held candidates kept per target; older ones past this cap are counted, not kept. */
const MAX_HELD = 40;
/** Held items named inline in one notice before the rest spill to a pointer. */
const MAX_PENDING_INLINE = 8;
/** Own merges remembered per repository. */
const MAX_OWN_MERGES = 20;

export const stateDir = () => process.env.PI_GITWATCH_DIR ?? join(homedir(), '.pi', 'agent', 'gitwatch');

export class Store {
  constructor(readonly dir = stateDir()) {}
  private get file() { return join(this.dir, 'state.json'); }
  load(): State {
    try {
      const state = JSON.parse(readFileSync(this.file, 'utf8')) as State;
      if (state.version === 1 && state.repos) { repair(state); return state; }
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

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The file is read back as written by any version or by hand: a watch with an unknown mode is dropped, and missing or
 * mistyped fields get their empty value (a NaN failure count would never reach the notice threshold).
 */
function repair(state: State) {
  for (const [repo, watch] of Object.entries(state.repos)) {
    if (!watch || typeof watch !== 'object' || (watch.mode !== 'open' && watch.mode !== 'list')) { delete state.repos[repo]; continue; }
    if (!Array.isArray(watch.prs)) watch.prs = [];
    if (!watch.snapshots || typeof watch.snapshots !== 'object') watch.snapshots = {};
    if (!Number.isInteger(watch.failures)) watch.failures = 0;
    // Mistyped optional marks are dropped: they only change routing, never whether a failure reaches the agent.
    if (!isPlainObject(watch.subscribers)) delete watch.subscribers;
    if (!Array.isArray(watch.ownMerges)) delete watch.ownMerges;
    if (!isPlainObject(watch.held) || Object.values(watch.held).some(h => !isPlainObject(h) || !Array.isArray(h.items))) delete watch.held;
    // State written before failing-job links existed has none: no link is known for it until the next poll reads them.
    for (const s of [...Object.values(watch.snapshots), ...Object.values(watch.branches ?? {})]) {
      if (s.checks && !Array.isArray(s.checks.failedJobs)) s.checks.failedJobs = [];
    }
  }
}

const itemText = (e: WatchEvent) => (e.branch ? `${e.branch} ${e.text}` : e.pr ? `#${e.pr} ${e.text}` : `gitwatch ${e.text}`);

/** Held items named inline, the rest pointed at the status command; the cap's drops are counted. */
function pendingText(repo: string, items: WatchEvent[], omitted: number): string {
  const inline = items.slice(0, MAX_PENDING_INLINE).map(itemText);
  const more = items.length - MAX_PENDING_INLINE;
  return [inline.join('; '), ...more > 0 ? [`+${more} more (gitwatch {"action":"status","repo":"${repo}"})`] : [], ...omitted ? [`${omitted} earlier omitted`] : []]
    .filter(Boolean).join('; ');
}

/** The notice the agent receives: what changed per PR, its current line, the next step and the failing job links, then what waited for a turn. */
export function noticeText(repo: string, events: WatchEvent[], snapshots: Map<number, Snapshot>, now: number, branches = new Map<string, BranchSnapshot>(), pending: WatchEvent[] = [], omitted = 0): string {
  const byPr = new Map<number, WatchEvent[]>();
  const byBranch = new Map<string, WatchEvent[]>();
  for (const e of events) {
    if (e.branch) byBranch.set(e.branch, [...byBranch.get(e.branch) ?? [], e]);
    else byPr.set(e.pr, [...byPr.get(e.pr) ?? [], e]);
  }
  const lines = [...byPr].map(([pr, evs]) => {
    const s = snapshots.get(pr);
    const next = s && hint(s, repo);
    const jobs = s && jobsText(s.checks, repo, { pr });
    return `#${pr} ${evs.map(e => e.text).join('; ')}${s ? `\n  ${line(s)}` : ''}${next ? `\n  next: ${next}` : ''}${jobs ? `\n  ${jobs}` : ''}`;
  });
  for (const [name, evs] of byBranch) {
    const s = branches.get(name);
    const next = s && branchHint(s, repo);
    const jobs = s && jobsText(s.checks, repo, { branch: name });
    lines.push(`${name} ${evs.map(e => e.text).join('; ')}${s ? `\n  ${branchLine(s)}` : ''}${next ? `\n  next: ${next}` : ''}${jobs ? `\n  ${jobs}` : ''}`);
  }
  const waiting = pending.length || omitted ? [`  since last notice: ${pendingText(repo, pending, omitted)}`] : [];
  return [`[gitwatch] ${repo} · ${brt(now)}`, ...lines, ...waiting,
    `Automated watcher notice, not the operator's words: it neither grants nor withdraws permission. If the agent's standing rules or an earlier operator order cover the next step ("merge all", "work until merged"), take it now instead of reporting. More: gitwatch {"action":"status","repo":"${repo}"}`].join('\n');
}

/** Where an event's notice goes: the subscriber of its PR or branch when there is one, else this session (`main`). */
function targetOf(watch: RepoWatch, e: WatchEvent): string {
  const label = e.branch !== undefined ? watch.subscribers?.[`branch:${e.branch}`] : e.pr > 0 ? watch.subscribers?.[`pr:${e.pr}`] : undefined;
  return label ? `sub:${label}` : 'main';
}

/** One event per PR (or branch) and kind in a batch: a newer one replaces the older. Cleanup lines are separate facts: each is kept. */
const itemKey = (e: WatchEvent) => `${e.branch !== undefined ? `branch ${e.branch}` : `pr ${e.pr}`}|${e.kind}${e.kind === 'cleanup' ? `|${e.text}` : ''}`;

/** Adds candidates to a target's batch, keeping at most MAX_HELD items; the batch keeps the time its first item arrived. */
function mergeHeld(held: Held | undefined, incoming: WatchEvent[], now: number): Held {
  const items = [...held?.items ?? []];
  for (const e of incoming) {
    const at = items.findIndex(i => itemKey(i) === itemKey(e));
    if (at >= 0) items.splice(at, 1);
    items.push(e);
  }
  let omitted = held?.omitted ?? 0;
  if (items.length > MAX_HELD) { omitted += items.length - MAX_HELD; items.splice(0, items.length - MAX_HELD); }
  return { since: held?.since ?? now, items, ...omitted ? { omitted } : {} };
}

/**
 * Turns this poll's routed events into notices per target. A respond event wakes its target, carrying that target's
 * held candidates; a merge or a batch older than HELD_MAX_AGE_MS goes out quietly; the rest waits in the returned batches.
 * The caller keeps the batches only when it delivers: a status refresh decides the same notices but holds nothing.
 */
function planNotices(repo: string, watch: RepoWatch, routed: Routed[], cleanups: WatchEvent[], shown: Map<number, Snapshot>,
  shownBranches: Map<string, BranchSnapshot>, now: number, clone?: string): { notices: Notice[]; held: Record<string, Held> } {
  const targets = new Map<string, { respond: WatchEvent[]; candidates: WatchEvent[] }>();
  const bucket = (key: string) => {
    const found = targets.get(key) ?? { respond: [], candidates: [] };
    targets.set(key, found);
    return found;
  };
  for (const { event, decision } of routed) {
    if (decision.route === 'ignore') continue;
    const group = bucket(targetOf(watch, event));
    if (decision.route === 'respond') group.respond.push(event);
    else group.candidates.push(event);
  }
  for (const event of cleanups) bucket(targetOf(watch, event)).candidates.push(event);
  // A target holding candidates with nothing new still ages out here.
  for (const key of Object.keys(watch.held ?? {})) bucket(key);
  const held: Record<string, Held> = { ...watch.held };
  const notices: Notice[] = [];
  for (const [key, { respond, candidates }] of targets) {
    const next = candidates.length || held[key] ? mergeHeld(held[key], candidates, now) : undefined;
    // A merge, or the local cleanup it caused, is reported at once even when quiet: it is what the held changes wait for.
    const flush = respond.length > 0 || candidates.some(e => e.kind === 'merged' || e.kind === 'cleanup') || (next !== undefined && now - next.since >= HELD_MAX_AGE_MS);
    if (!flush) { if (next) held[key] = next; continue; }
    delete held[key];
    const primary = respond.filter(isShown);
    // A held candidate of the same PR (or branch) and kind is superseded by the respond event that now states it.
    const superseded = new Set(primary.map(itemKey));
    const pending = (next?.items ?? []).filter(i => !superseded.has(itemKey(i)));
    const subscriber = key === 'main' ? undefined : key.slice('sub:'.length);
    notices.push({
      repo, events: [...primary, ...pending], wake: respond.length > 0,
      text: noticeText(repo, primary, shown, now, shownBranches, pending, next?.omitted ?? 0),
      ...clone ? { clone } : {}, ...subscriber ? { subscriber } : {},
    });
  }
  return { notices, held };
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

  /** Records whether a subscriber took a notice on the event bus, or the notice fell back to this session. */
  recordSubscriber(claimed: boolean): Promise<void> {
    return this.exclusive(async () => {
      const state = this.store.load();
      const delivery = state.deliveries ??= { since: this.now(), wakeAccepted: 0, quietAccepted: 0, uncertain: 0 };
      if (claimed) delivery.subscriberClaimed = (delivery.subscriberClaimed ?? 0) + 1;
      else delivery.subscriberFallback = (delivery.subscriberFallback ?? 0) + 1;
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
      const { snapshots, branches } = branch && request.head !== undefined && !tracksPulls(watch)
        ? { snapshots: new Map<number, Snapshot>(), branches: new Map(request.head ? [[branch, normalizeBranch(branch, request.head)]] : []) }
        : await this.fetch(repo, watch, undefined, branch);
      const missing = watch.prs.filter(n => !snapshots.has(n));
      if (missing.length) throw new Error(`Not found in ${repo}: ${missing.map(n => `#${n}`).join(', ')}.`);
      if (branch && !branches.get(branch)) throw new Error(`Branch ${branch} not found in ${repo}.`);
      for (const [n, s] of snapshots) if (takesSnapshot(watch, n, s)) watch.snapshots[n] = keepTracked(settle(watch.snapshots[n], s), watch.snapshots[n]);
      if (branch) watch.branches![branch] = baselineBranch(branches.get(branch)!);
      if (request.subscriber) setSubscribers(watch, request.prs ?? [], branch, request.subscriber);
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
        pruneSubscribers(watch);
        if (isEmpty(watch)) delete state.repos[repo];
      } else if (prs?.length) {
        watch.prs = watch.prs.filter(n => !prs.includes(n));
        for (const n of prs) delete watch.snapshots[n];
        pruneSubscribers(watch);
        if (watch.mode === 'open') watch.ignore = [...new Set([...watch.ignore ?? [], ...prs])];
        if (isEmpty(watch)) delete state.repos[repo];
      }
      this.store.save(state);
      return true;
    });
  }

  /**
   * Notes that this session merged `pr` itself with `gh pr merge` (not queued): the merge is then known to the agent and
   * routed as ignored. Only a PR the watch follows is noted; anything else is left to the default route.
   */
  noteOwnMerge(repo: string, pr: number): Promise<boolean> {
    return this.exclusive(async () => {
      const state = this.store.load();
      const watch = state.repos[repo];
      if (!watch || (watch.mode === 'list' && !watch.prs.includes(pr))) return false;
      watch.ownMerges = [...new Set([...watch.ownMerges ?? [], pr])].slice(-MAX_OWN_MERGES);
      this.store.save(state);
      return true;
    });
  }

  /**
   * Polls every watched repository (or one), saves the new state and returns the notices worth delivering. The events of
   * every repository are returned too: they are what a status refresh shows.
   */
  poll(only?: string, signal?: AbortSignal, options: PollOptions = {}): Promise<{ notices: Notice[]; events: Map<string, WatchEvent[]> }> {
    const deliver = options.deliver ?? true;
    return this.exclusive(async () => {
      const state = this.store.load();
      const notices: Notice[] = [];
      const all = new Map<string, WatchEvent[]>();
      const watched = Object.entries(state.repos).filter(([repo]) => !only || repo === only);
      // Each repository is an independent read, so they are fetched together; results are still applied in order below.
      const failed: { repo: string; failures: number; error: string }[] = [];
      const fetched = await settleBounded(watched, FETCH_CONCURRENCY, ([repo, watch]) => this.fetch(repo, watch, signal));
      for (const [index, [repo, watch]] of watched.entries()) {
        try {
          const { snapshots, open, branches } = settledValue(fetched[index]);
          const routed = [...advancePrs(watch, snapshots, open, this.now()), ...advanceBranches(watch, branches)];
          if (watch.failures >= noticeAfter(watch.lastError)) routed.push({ event: { pr: 0, kind: 'checks', text: `polling recovered after ${watch.failures} failures`, wake: false }, decision: { route: 'candidate', reason: 'quiet' } });
          watch.failures = 0; delete watch.lastError; watch.lastPoll = this.now();
          const shown = new Map(Object.values(watch.snapshots).map(s => [s.number, s]));
          const shownBranches = new Map(Object.entries(watch.branches ?? {}));
          const { clone } = watch;
          const { events: cleanups, settled } = await cleanupEvents(watch, routed, options.cleanup);
          // An auto-merge whose cleanup left nothing to do needs no turn: it is delivered with the next one.
          for (const r of routed) r.decision = handledMerge(r.decision, r.event, settled.has(r.event.pr));
          countRoutes(state, this.now(), routed);
          forgetOwnMerges(watch, routed);
          const planned = planNotices(repo, watch, routed, cleanups, shown, shownBranches, this.now(), clone);
          for (const n of planned.notices) if (!n.subscriber) { const stats = state.stats ??= { since: this.now(), woke: 0, quiet: 0 }; if (n.wake) stats.woke++; else stats.quiet++; }
          if (deliver) {
            watch.held = Object.keys(planned.held).length ? planned.held : undefined;
            if (!watch.held) delete watch.held;
            notices.push(...planned.notices);
          }
          this.prune(watch, true);
          all.set(repo, [...routed.map(r => r.event), ...cleanups]);
          if (isEmpty(watch) && !watch.held) delete state.repos[repo];
        } catch (error) {
          if (signal?.aborted) throw error;
          watch.failures++; watch.lastError = error instanceof Error ? error.message : String(error);
          if (watch.failures === noticeAfter(watch.lastError)) failed.push({ repo, failures: watch.failures, error: watch.lastError });
        }
      }
      if (failed.length) notices.push(this.failureNotice(failed, state.intervalSec));
      this.store.save(state);
      return { notices, events: all };
    });
  }

  /** One outage fails every repository together: they share a notice instead of waking the agent once each. */
  private failureNotice(failed: { repo: string; failures: number; error: string }[], intervalSec: number): Notice {
    const [first] = failed;
    const many = failed.length > 1;
    const head = `[gitwatch] ${many ? `${failed.length} repositories` : first.repo} · ${brt(this.now())}`;
    const body = many
      ? `Polling failed ${first.failures} times in a row for each:\n${failed.map(f => `- ${f.repo}: ${f.error}`).join('\n')}`
      : `Polling failed ${first.failures} times in a row: ${first.error}`;
    const stop = `gitwatch {"action":"unwatch","repo":"${first.repo}"}${many ? ' (once per repository)' : ''}`;
    return { repo: first.repo, events: [], wake: true, text: `${head}\n${body}\nThe watch keeps retrying every ${intervalSec}s. Check \`gh auth status\`; stop with ${stop}.` };
  }

  private async fetch(repo: string, watch: RepoWatch, signal?: AbortSignal, extraBranch?: string) {
    const tracked = [...new Set([...watch.prs, ...Object.keys(watch.snapshots).map(Number)])].slice(0, MAX_PRS);
    const names = [...new Set([...Object.keys(watch.branches ?? {}), ...extraBranch ? [extraBranch] : []])];
    // A list watch that only holds candidates for later has nothing to read: no GraphQL request without a PR or branch.
    if (watch.mode === 'list' && !tracked.length && !names.length) return { snapshots: new Map<number, Snapshot>(), open: undefined, branches: new Map<string, BranchSnapshot>() };
    const fetched = await fetchRepo(this.run, repo, tracked, watch.mode === 'open', signal, names);
    // A PR removed from an open watch is re-read on every poll and never stored: its failure would look new each time.
    const prs = [...fetched.prs].map(([n, raw]) => ({ n, read: reading(watch.snapshots[n], headRollup(raw), !watch.ignore?.includes(n), steps => normalize(raw, steps)) }));
    const heads = [...fetched.branches].flatMap(([name, raw]) => raw ? [{ name, read: reading(watch.branches?.[name], raw.statusCheckRollup, true, steps => normalizeBranch(name, raw, steps)) }] : []);
    const steps = await this.stepsOf([...prs, ...heads].flatMap(r => r.read.ask ?? []), signal);
    return {
      snapshots: new Map(prs.map(({ n, read }) => [n, snapshotOf(read, steps)])), open: fetched.open,
      branches: new Map(heads.map(({ name, read }) => [name, snapshotOf(read, steps)])),
    };
  }

  /**
   * The steps these failed jobs ran, in one request for all of them, or the reason they could not be read. A failed read
   * neither drops nor postpones the failure it is about: that one is announced as an ordinary failure and keeps the reason.
   */
  private async stepsOf(ids: string[], signal?: AbortSignal): Promise<Steps | string> {
    if (!ids.length) return new Map();
    try { return await fetchSteps(this.run, ids, signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      return (error instanceof Error ? error.message : String(error)) || 'no reason given';
    }
  }

  /**
   * Merged and closed PRs are reported once, then forgotten; a list watch keeps only the PRs still open. After a poll,
   * a branch whose CI was reported is dropped too, and so is a subscriber whose PR or branch is no longer followed.
   */
  private prune(watch: RepoWatch, branches = false) {
    for (const [n, s] of Object.entries(watch.snapshots)) if (s.state !== 'OPEN') delete watch.snapshots[n];
    // Named PRs that are no longer open leave the list in both modes; an open watch kept them and re-read them forever.
    watch.prs = watch.prs.filter(n => watch.snapshots[n]);
    // A held change of a PR that is gone is stale: a status refresh showed the merge and dropped the PR, and 30 minutes
    // later its "checks passed, mergeable" went out on its own after the merge (03/11, pi-optchat #98).
    for (const [key, h] of Object.entries(watch.held ?? {})) {
      const items = h.items.filter(i => i.branch !== undefined || i.pr <= 0 || watch.snapshots[i.pr]);
      if (items.length) watch.held![key] = { ...h, items };
      else delete watch.held![key];
    }
    if (watch.held && !Object.keys(watch.held).length) delete watch.held;
    if (branches && watch.branches) {
      for (const [name, s] of Object.entries(watch.branches)) if (s.reported) delete watch.branches[name];
      if (!Object.keys(watch.branches).length) delete watch.branches;
    }
    pruneSubscribers(watch);
  }
}

/** A commit and its checks: what a PR snapshot and a branch snapshot have in common. */
interface Head { head: string; checks: Checks }

/** Whether the failure stored for a head is the one just read: the same commit with the same failing checks. */
const sameFailure = (stored: Head | undefined, read: Head): stored is Head =>
  stored !== undefined && stored.head === read.head && stored.checks.state === 'fail' && read.checks.state === 'fail' && stored.checks.failing.join() === read.checks.failing.join();

/**
 * A head as it was just read (`plain`: without step counts), next to what is stored for it. `ask` holds the node ids of
 * its failed jobs when its failure is not the stored one and is made of GitHub Actions jobs: only then, so once per
 * failure, is GitHub asked whether those jobs ran a step.
 */
interface Reading<S extends Head> { stored: S | undefined; plain: S; ask: string[] | undefined; build: (steps: Steps) => S }

function reading<S extends Head>(stored: S | undefined, rollup: RawCommit['statusCheckRollup'] | undefined, followed: boolean, build: (steps?: Steps) => S): Reading<S> {
  const plain = build();
  const fresh = followed && plain.checks.state === 'fail' && !sameFailure(stored, plain);
  return { stored, plain, build, ask: fresh ? failedJobIds(rollup, plain.checks.failing) : undefined };
}

/**
 * The snapshot of a head once the step counts were asked for. A new failure is read again with them; when they could not
 * be read (`steps` is the reason) it stays an ordinary failure that carries that reason. A failure already stored keeps
 * what was learned about it.
 */
function snapshotOf<S extends Head>({ stored, plain, ask, build }: Reading<S>, steps: Steps | string): S {
  if (ask) return typeof steps === 'string' ? { ...plain, checks: { ...plain.checks, stepsError: steps } } : build(steps);
  if (!sameFailure(stored, plain)) return plain;
  const { neverStarted, stepsError } = stored.checks;
  return { ...plain, checks: { ...plain.checks, ...neverStarted ? { neverStarted } : {}, ...stepsError ? { stepsError } : {} } };
}

/**
 * Concurrent GitHub reads per poll. A few repositories are typical, so this only caps a burst for a long watch list
 * and keeps the `gh` process count and GraphQL rate use bounded.
 */
const FETCH_CONCURRENCY = 4;

/** Runs `work` for every item with at most `limit` in flight; each outcome is settled and returned in input order. */
async function settleBounded<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { status: 'fulfilled', value: await work(items[index]) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

/** The value of a settled read, or its failure rethrown where the caller handles it. */
function settledValue<R>(outcome: PromiseSettledResult<R>): R {
  if (outcome.status === 'rejected') throw outcome.reason;
  return outcome.value;
}


/** A subscriber stays only while its PR or branch is followed. */
function pruneSubscribers(watch: RepoWatch) {
  if (!watch.subscribers) return;
  for (const key of Object.keys(watch.subscribers)) {
    const pr = /^pr:(\d+)$/.exec(key), branch = /^branch:(.+)$/.exec(key);
    const followed = pr ? watch.snapshots[pr[1]] !== undefined : branch ? watch.branches?.[branch[1]] !== undefined : false;
    if (!followed) delete watch.subscribers[key];
  }
  if (!Object.keys(watch.subscribers).length) delete watch.subscribers;
}

function setSubscribers(watch: RepoWatch, prs: number[], branch: string | undefined, label: string) {
  const subscribers = watch.subscribers ??= {};
  for (const n of prs) subscribers[`pr:${n}`] = label;
  if (branch) subscribers[`branch:${branch}`] = label;
}

/**
 * Whether a re-read PR replaces its stored snapshot. A PR that merged or closed since the last poll keeps its stored open
 * snapshot, so the next poll announces the transition.
 */
const takesSnapshot = (watch: RepoWatch, n: number, s: Snapshot): boolean =>
  ((s.state === 'OPEN' && !watch.ignore?.includes(n)) || watch.prs.includes(n)) && (s.state === 'OPEN' || watch.snapshots[n] === undefined);

/**
 * A snapshot taken over an earlier one keeps what the agent was already told about the PR, and the auto-merge stall clock of
 * the same head: a new head starts its own clock.
 */
const keepTracked = (next: Snapshot, prev: Snapshot | undefined): Snapshot => {
  if (!prev) return next;
  const sameHead = prev.head === next.head && prev.passedAt !== undefined;
  return {
    ...next,
    ...prev.announced ? { announced: prev.announced } : {},
    ...sameHead ? { passedAt: prev.passedAt, stallReported: prev.stallReported } : {},
  };
};

/** The watch a request leads to, before GitHub confirms its PRs and branch exist. */
function nextWatch(existing: RepoWatch | undefined, { prs, branch }: WatchRequest): RepoWatch {
  const mode = prs?.length || branch ? 'list' : 'open';
  const merged = mode === 'list' && existing?.mode === 'list' ? [...new Set([...existing.prs, ...prs ?? []])] : prs ?? [];
  if (merged.length > MAX_PRS) throw new Error(`At most ${MAX_PRS} PRs per repository.`);
  const watch: RepoWatch = {
    mode: existing?.mode === 'open' ? 'open' : mode, prs: merged.sort((a, b) => a - b), snapshots: existing?.snapshots ?? {},
    failures: 0, ...existing?.branches ? { branches: existing.branches } : {},
    ...existing?.subscribers ? { subscribers: existing.subscribers } : {},
    ...existing?.ownMerges ? { ownMerges: existing.ownMerges } : {},
    ...existing?.held ? { held: existing.held } : {},
  };
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

/** A transition the watcher routed, with the reason. */
interface Routed { event: WatchEvent; decision: Decision }

/** Moves every tracked PR to its new snapshot and routes the transitions, auto-merge stalls included. */
function advancePrs(watch: RepoWatch, snapshots: Map<number, Snapshot>, open: number[] | undefined, now: number): Routed[] {
  const out: Routed[] = [];
  for (const n of new Set([...Object.keys(watch.snapshots).map(Number), ...watch.prs, ...open ?? []])) {
    const cur = snapshots.get(n);
    if (watch.ignore?.includes(n) || !cur) continue;
    const prev = watch.snapshots[n];
    const { snapshot, event: stall } = autoMergeStall(prev, settle(prev, cur), now);
    let next = snapshot;
    if (prev || watch.mode === 'open') {
      let announced: Announced | undefined = prev?.announced;
      const events = [...diff(prev, next), ...stall ? [stall] : []];
      for (const event of events) {
        const decision = routeEvent(event, { ownMerge: watch.ownMerges?.includes(n) ?? false, cur: next, announced });
        out.push({ event, decision });
        if (decision.route === 'respond') announced = announce(announced, event, next);
      }
      if (announced) next = { ...next, announced };
    }
    watch.snapshots[n] = next;
  }
  return out;
}

/** Moves every watched branch to its latest commit; a deleted branch has nothing left to report and is dropped. */
function advanceBranches(watch: RepoWatch, branches: Map<string, BranchSnapshot>): Routed[] {
  const out: Routed[] = [];
  for (const [name, prev] of Object.entries(watch.branches ?? {})) {
    const cur = branches.get(name);
    if (!cur) { delete watch.branches![name]; continue; }
    const { snapshot, events } = branchDiff(prev, cur);
    watch.branches![name] = snapshot;
    for (const event of events) out.push({ event, decision: routeEvent(event) });
  }
  return out;
}

/**
 * Local cleanup for the merged PRs of this poll, whatever their route: a merge this session made still cleans its
 * branches. `settled` holds the PRs whose cleanup ran and left nothing for the agent; no known clone settles none.
 */
async function cleanupEvents(watch: RepoWatch, routed: Routed[], cleanup?: PollOptions['cleanup']): Promise<{ events: WatchEvent[]; settled: Set<number> }> {
  const clone = watch.clone;
  const merged = routed.map(r => r.event).filter(e => e.kind === 'merged' && e.head !== undefined);
  if (!cleanup || !clone || !merged.length) return { events: [], settled: new Set() };
  const lines = await cleanup({ clone, events: merged });
  const left = new Set(lines.filter(l => l.left).map(l => l.pr));
  // Fast-forward and reload lines already name their folder; the others are about the clone the push came from.
  const events = lines.map(l => ({ pr: l.pr, kind: 'cleanup' as const, text: /^(reload needed|fast-forwarded|skipped fast-forward|switched)/.test(l.text) ? l.text : `${l.text} (in ${clone})`, wake: false }));
  return { events, settled: new Set(merged.map(e => e.pr).filter(pr => !left.has(pr))) };
}

function countRoutes(state: State, now: number, routed: Routed[]) {
  const routes = state.routes ??= { since: now, respond: 0, candidate: 0, ignore: 0 };
  for (const { decision } of routed) routes[decision.route]++;
}

/** A merge or close ends the own-merge mark of its PR once the watcher has seen it. */
function forgetOwnMerges(watch: RepoWatch, routed: Routed[]) {
  if (!watch.ownMerges) return;
  const ended = new Set(routed.filter(r => r.event.kind === 'merged' || r.event.kind === 'closed').map(r => r.event.pr));
  watch.ownMerges = watch.ownMerges.filter(n => !ended.has(n));
  if (!watch.ownMerges.length) delete watch.ownMerges;
}

/**
 * After a push of `branch`: follows its open PR when it has one (an open-PR watch already does), else the CI of
 * the pushed commit. Returns what is now followed.
 */
export async function watchPush(watcher: Watcher, repo: string, branch: string, clone?: string): Promise<string> {
  const { pr, head } = await lookupPush(watcher.run, repo, branch);
  if (!pr) {
    await watcher.watch(repo, { branch, clone, head });
    return `${repo} ${branch} CI`;
  }
  const existing = watcher.state().repos[repo];
  const covered = existing && (existing.mode === 'open' ? !existing.ignore?.includes(pr) : existing.prs.includes(pr));
  if (!covered || (clone && existing.clone !== clone)) await watcher.watch(repo, { prs: [pr], clone });
  return `${repo} #${pr}`;
}

/** Whether a watch needs the pull requests read on every fetch: an open watch, a listed PR, or a snapshot still shown. */
function tracksPulls(watch: RepoWatch): boolean {
  return watch.mode === 'open' || watch.prs.length > 0 || Object.keys(watch.snapshots).length > 0;
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
    + `\nEvery ${state.intervalSec}s the watcher requests a turn on failed or finished checks, conflicts, merges (auto-merge included) and closes, and when a watched branch's CI finishes.${stats}`;
}

/** Lifetime counters across all repositories; no historical routing count is upgraded to delivery evidence. */
const sinceText = (at: number) => new Date(at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function deliveryText(state: State): string {
  const planned = state.stats;
  const routing = planned ? `\nRouting decisions (all repos) since ${sinceText(planned.since)}: ${planned.woke} wake, ${planned.quiet} next-turn; not delivery evidence.` : '';
  const byEvent = state.routes
    ? `\nRouting by event (all repos) since ${sinceText(state.routes.since)}: ${state.routes.respond} respond, ${state.routes.candidate} candidate (waits for the next notice), ${state.routes.ignore} ignored (merges the agent made itself; not sent).`
    : '';
  const d = state.deliveries;
  if (!d) return routing + byEvent + '\nHost delivery: not measured yet; model runs and saved turns unknown.';
  const subscribers = d.subscriberClaimed !== undefined || d.subscriberFallback !== undefined
    ? `\nSubscribers (all repos): ${d.subscriberClaimed ?? 0} notices taken by a subscriber, ${d.subscriberFallback ?? 0} handed back here because none accepted.`
    : '';
  return routing + byEvent + `\nDelivery evidence (all repos) since ${sinceText(d.since)}. Host accepted: ${d.wakeAccepted} wake requests, ${d.quietAccepted} next-turn notices; ${d.uncertain} uncertain (no automatic replay). These are not model runs or saved turns.` + subscribers;
}

/** One repository's status: totals, poll health, changes this refresh found, what waits for a turn, then a line per PR and branch. */
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
  const waiting = Object.entries(w.held ?? {}).map(([key, h]) => `\nwaiting ${key === 'main' ? 'for your next turn' : `for ${key.slice('sub:'.length)}`}: ${pendingText(repo, h.items, h.omitted ?? 0)}`).join('');
  const withNext = (text: string, next?: string, jobs?: string, unread?: string) => `${text}${next ? `\n  next: ${next}` : ''}${jobs ? `\n  ${jobs}` : ''}${unread ? `\n  ${unread}` : ''}`;
  const tag = (key: string) => (w.subscribers?.[key] ? ` · for ${w.subscribers[key]}` : '');
  const rows = [
    ...prs.map(s => withNext(`${line(s)}${tag(`pr:${s.number}`)}`, hint(s, repo), jobsText(s.checks, repo, { pr: s.number }), stepsUnread(s.checks))),
    ...Object.values(w.branches ?? {}).map(b => withNext(`${branchLine(b)}${tag(`branch:${b.branch}`)}`, branchHint(b, repo), jobsText(b.checks, repo, { branch: b.branch }), stepsUnread(b.checks))),
  ];
  const empty = w.mode === 'open' ? 'no open PRs; new ones will be reported' : 'nothing left to follow';
  return [`${repo} · ${totals} · ${polled}${error}${changed}${waiting}`, ...rows.length ? rows : [empty]].join('\n');
}
