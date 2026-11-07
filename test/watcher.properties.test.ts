import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MERGE_STALL_MS, type RawPullRequest } from '../src/model.ts';
import { Store, Watcher } from '../src/watcher.ts';
import { FakeGitHub, pr, tempDir, type Check } from './fixtures.ts';

// Model-based test of the watcher: random histories of PRs on a fake GitHub, polled by the real Watcher. An oracle
// restates the routing rules from the observed state, and every poll must wake exactly as often as the oracle says.
// Seeded generator: a failing case reproduces from its seed, which every assertion message carries.
const rng = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const CASES = 200;
type Next = () => number;
const pick = <T>(next: Next, items: readonly T[]): T => items[Math.floor(next() * items.length)];

const PRS = [1, 2, 3];
const HEADS = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'];
const MERGE_STATES = ['CLEAN', 'CLEAN', 'BLOCKED', 'DIRTY', 'BEHIND', 'UNKNOWN'];
const REVIEWS = [null, 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'];
// Long steps let an auto-merge stall come due between two edits of the same PR, which is where re-watches matter.
const CLOCK_STEPS = [30_000, 30_000, 2 * 60_000, 11 * 60_000, 11 * 60_000];

type Kind = 'pass' | 'fail' | 'lintFail' | 'pending' | 'lintPending' | 'none';
/** Each check set with the summary the watcher must derive from it. */
const CHECKS: Record<Kind, { checks: Check[]; state: 'pass' | 'fail' | 'pending' | 'none'; failing: string }> = {
  pass: { checks: [['test', 'COMPLETED', 'SUCCESS']], state: 'pass', failing: '' },
  fail: { checks: [['test', 'COMPLETED', 'FAILURE']], state: 'fail', failing: 'test' },
  lintFail: { checks: [['test', 'COMPLETED', 'SUCCESS'], ['lint', 'COMPLETED', 'FAILURE']], state: 'fail', failing: 'lint' },
  pending: { checks: [['test', 'IN_PROGRESS']], state: 'pending', failing: '' },
  lintPending: { checks: [['test', 'COMPLETED', 'SUCCESS'], ['lint', 'IN_PROGRESS']], state: 'pending', failing: '' },
  none: { checks: [], state: 'none', failing: '' },
};
const KINDS = Object.keys(CHECKS) as Kind[];

/** What GitHub currently says about one PR. */
interface Truth { head: string; kind: Kind; mergeState: string; draft: boolean; review: string | null; auto: boolean; terminal?: 'MERGED' | 'CLOSED' }
/** What the watcher should have stored after its last poll of a PR (GitHub's UNKNOWN settled as the watcher does). */
interface Obs { head: string; checks: 'pass' | 'fail' | 'pending' | 'none'; failing: string; mergeState: string; draft: boolean; review: string | null; auto: boolean }
/** What the agent was last told per slot of a PR, from wakes only. */
interface Told { checks?: string; mergeState?: string }
/** The stall clock of a PR: an auto-merge that has passed on this head since `since`. */
interface Episode { head: string; since: number; reported: boolean }

const raw = (n: number, t: Truth): RawPullRequest => pr(n, {
  headRefOid: t.head.padEnd(40, '0'), mergeStateStatus: t.mergeState, isDraft: t.draft, reviewDecision: t.review,
  autoMergeRequest: t.auto ? {} : null, state: t.terminal ?? 'OPEN',
  ...t.terminal === 'MERGED' ? { mergeCommit: { oid: 'abcdef123456' } } : {},
}, CHECKS[t.kind].checks);

function randomTruth(next: Next): Truth {
  return { head: pick(next, HEADS), kind: pick(next, KINDS), mergeState: pick(next, MERGE_STATES), draft: next() < 0.1, review: pick(next, REVIEWS), auto: next() < 0.5 };
}

/** One GitHub edit: a head push, a check change, a merge-state flap, a draft, a review, auto-merge, or the end of the PR. */
function mutate(next: Next, t: Truth) {
  const field = next() < 0.04 ? 'terminal' : pick(next, ['head', 'kind', 'kind', 'mergeState', 'draft', 'review', 'auto'] as const);
  if (field === 'head') t.head = pick(next, HEADS);
  else if (field === 'kind') t.kind = pick(next, KINDS);
  else if (field === 'mergeState') t.mergeState = pick(next, MERGE_STATES);
  else if (field === 'draft') t.draft = !t.draft;
  else if (field === 'review') t.review = pick(next, REVIEWS);
  else if (field === 'auto') t.auto = !t.auto;
  else t.terminal = pick(next, ['MERGED', 'CLOSED'] as const);
}

function observe(t: Truth, prev?: Obs): Obs {
  // GitHub's UNKNOWN (still computing) keeps the last known merge state of the same head.
  const mergeState = t.mergeState === 'UNKNOWN' && prev && prev.head === t.head ? prev.mergeState : t.mergeState;
  const { state, failing } = CHECKS[t.kind];
  return { head: t.head, checks: state, failing, mergeState, draft: t.draft, review: t.review, auto: t.auto };
}

/** A checks change wakes when it fails, or when it passes outside auto-merge and not again on the same head; pending waits. */
function checksWake(prev: Obs, cur: Obs, told: Told): number {
  if (cur.checks === prev.checks && !(cur.checks === 'fail' && cur.failing !== prev.failing)) return 0;
  if (cur.checks === 'fail') { told.checks = `fail@${cur.head}`; return 1; }
  if (cur.checks !== 'pass' || cur.auto) return 0;
  if (told.checks === `pass@${cur.head}`) return 0;
  told.checks = `pass@${cur.head}`;
  return 1;
}

/** A merge-state change wakes on a conflict, on BEHIND once checks are no longer running, and on a ready-to-merge PR. */
function mergeStateWake(prev: Obs, cur: Obs, told: Told): number {
  if (cur.mergeState === prev.mergeState || cur.mergeState === 'UNKNOWN') return 0;
  const ready = cur.mergeState === 'CLEAN' && !cur.auto && !cur.draft;
  const wakes = cur.mergeState === 'DIRTY' || (cur.mergeState === 'BEHIND' && cur.checks !== 'pending') || ready;
  if (!wakes || (ready && told.mergeState === `CLEAN@${cur.head}`)) return 0;
  told.mergeState = `${cur.mergeState}@${cur.head}`;
  return 1;
}

/** The oracle: the wakes the rules owe for each poll, derived from the observed history and what the agent was told. */
class Oracle {
  readonly obs = new Map<number, Obs>();
  readonly told = new Map<number, Told>();
  readonly episode = new Map<number, Episode>();
  constructor(readonly truth: Map<number, Truth>) {
    PRS.forEach(n => this.obs.set(n, observe(truth.get(n)!)));
  }

  /** A re-follow reads every open PR again; a PR that already ended is not replaced by its final state here. */
  reread() {
    for (const [n, prev] of this.obs) {
      const t = this.truth.get(n)!;
      if (!t.terminal) this.obs.set(n, observe(t, prev));
    }
  }

  /** The poll at `now`: how many wakes it owes, which PRs stalled, and which PRs ended. */
  poll(now: number): { responds: number; stalls: number[]; ended: number[] } {
    let responds = 0;
    const stalls: number[] = [], ended: number[] = [];
    for (const n of PRS) {
      const prev = this.obs.get(n);
      if (!prev) continue;
      const t = this.truth.get(n)!;
      if (t.terminal) {
        // A merge or a close always wakes; the PR is then no longer followed.
        responds++; ended.push(n);
        this.obs.delete(n); this.episode.delete(n);
        continue;
      }
      const cur = observe(t, prev);
      const told = this.told.get(n) ?? {};
      this.told.set(n, told);
      const reviewWakes = cur.review !== prev.review && (cur.review === 'APPROVED' || cur.review === 'CHANGES_REQUESTED');
      responds += checksWake(prev, cur, told) + mergeStateWake(prev, cur, told) + (reviewWakes ? 1 : 0);
      if (this.stallDue(n, cur, now)) { stalls.push(n); responds++; }
      this.obs.set(n, cur);
    }
    return { responds, stalls, ended };
  }

  /** Auto-merge with passing checks on one head: one stall once the threshold passed, then the clock is spent for that head. */
  private stallDue(n: number, cur: Obs, now: number): boolean {
    if (!(cur.auto && cur.checks === 'pass')) { this.episode.delete(n); return false; }
    let ep = this.episode.get(n);
    if (!ep || ep.head !== cur.head) { ep = { head: cur.head, since: now, reported: false }; this.episode.set(n, ep); }
    if (ep.reported || now - ep.since < AUTO_MERGE_STALL_MS) return false;
    ep.reported = true;
    return true;
  }
}

test('every poll wakes as often as the routing rules owe, merges and closes always wake, stalls come once per head, and ended PRs never return', async () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed);
    const gh = new FakeGitHub();
    let clock = Date.UTC(2026, 9, 30, 16, 50);
    const watcher = new Watcher(new Store(tempDir()), gh.run, () => clock);
    const truth = new Map(PRS.map(n => [n, randomTruth(next)] as const));
    gh.set(...PRS.map(n => raw(n, truth.get(n)!)));
    await watcher.watch('o/r');
    const oracle = new Oracle(truth);
    const ended = new Set<number>();
    const steps = 5 + Math.floor(next() * 40);
    for (let step = 0; step < steps; step++) {
      for (let edits = Math.floor(next() * 3); edits > 0; edits--) {
        const t = truth.get(pick(next, PRS))!;
        if (!t.terminal) mutate(next, t);
      }
      gh.set(...PRS.map(n => raw(n, truth.get(n)!)));
      clock += pick(next, CLOCK_STEPS);
      const followed = PRS.filter(n => oracle.obs.has(n));
      if (followed.length && next() < 0.25) {
        await watcher.watch('o/r', { prs: [pick(next, followed)] });
        oracle.reread();
      }
      const deliver = next() < 0.85;
      const before = watcher.state().routes?.respond ?? 0;
      const { notices, events } = await watcher.poll(undefined, undefined, { deliver });
      const routed = (watcher.state().routes?.respond ?? 0) - before;
      const owed = oracle.poll(clock);
      const where = `seed ${seed} step ${step}`;
      assert.equal(routed, owed.responds, `${where}: wakes routed`);
      const seenStalls = (events.get('o/r') ?? []).filter(e => e.kind === 'stall').map(e => e.pr).sort();
      assert.deepEqual(seenStalls, [...owed.stalls].sort(), `${where}: stalls`);
      for (const e of events.get('o/r') ?? []) assert.ok(e.pr === 0 || !ended.has(e.pr), `${where}: event for an ended PR ${e.pr} "${e.text}"`);
      for (const n of owed.ended) ended.add(n);
      // An ended PR is dropped from the stored state, so no status line lists it again.
      const stored = watcher.state().repos['o/r']?.snapshots ?? {};
      for (const n of ended) assert.ok(!(String(n) in stored), `${where}: ended PR ${n} still stored`);
      if (deliver) assert.equal(notices.filter(n => n.wake).length, owed.responds > 0 ? 1 : 0, `${where}: wake notices`);
      else assert.equal(notices.length, 0, `${where}: a status refresh delivers nothing`);
    }
  }
});
