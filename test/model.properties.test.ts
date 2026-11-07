import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_MERGE_STALL_MS, autoMergeStall, branchDiff, CONTEXTS_PAGE, diff, normalize, normalizeBranch, settle, summarizeChecks,
  type Announced, type BranchSnapshot, type RawCommit, type RawPullRequest, type Snapshot,
} from '../src/model.ts';
import { announce, routeEvent } from '../src/route.ts';
import { pr, type Check } from './fixtures.ts';

// Seeded generator: a failing case reproduces from its seed, which every assertion message carries.
const rng = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const CASES = 200;
type Next = () => number;
const pick = <T>(next: Next, items: readonly T[]): T => items[Math.floor(next() * items.length)];
const shuffle = <T>(next: Next, items: readonly T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
};

type Context = Parameters<typeof summarizeChecks>[0][number];
type Verdict = 'pass' | 'fail' | 'pending' | 'skip';
/** A check as the test intends it, before it is spelled the way GitHub reports it. */
interface Item { name: string; verdict: Verdict; conclusion: string; run?: number; status: boolean }

const NAMES = ['test', 'lint', 'build', 'ci/status'] as const;
const RUNS = [101, 102, 103];
const CONCLUSIONS: Record<Verdict, string[]> = {
  pass: ['SUCCESS', 'NEUTRAL'], fail: ['FAILURE', 'CANCELLED', 'TIMED_OUT'], skip: ['SKIPPED'], pending: ['IN_PROGRESS', 'QUEUED'],
};

function item(next: Next, name: string, verdict: Verdict, run?: number): Item {
  // `ci/status` is a commit status (StatusContext) unless the check is skipped, which only CheckRuns can be.
  return { name, verdict, conclusion: pick(next, CONCLUSIONS[verdict]), status: name === 'ci/status' && verdict !== 'skip', ...run === undefined ? {} : { run } };
}

function randomItems(next: Next, count: number): Item[] {
  return Array.from({ length: count }, () => {
    const verdict = pick<Verdict>(next, ['pass', 'pass', 'fail', 'pending', 'skip']);
    return item(next, pick(next, NAMES), verdict, next() < 0.7 ? pick(next, RUNS) : undefined);
  });
}

const url = (run: number | undefined) => (run === undefined ? undefined : `https://github.com/o/r/actions/runs/${run}/job/1`);

/** The GitHub context of an item: a CheckRun, or a commit status for the `ci/status` name. */
function spell(i: Item): Context {
  const link = url(i.run);
  if (i.status) {
    const state = i.verdict === 'pass' ? 'SUCCESS' : i.verdict === 'pending' ? 'PENDING' : i.conclusion;
    return { __typename: 'StatusContext', context: i.name, state, ...link ? { targetUrl: link } : {} };
  }
  const running = i.verdict === 'pending';
  return {
    __typename: 'CheckRun', name: i.name, status: running ? 'IN_PROGRESS' : 'COMPLETED',
    conclusion: running ? null : i.conclusion, ...link ? { detailsUrl: link } : {},
  };
}

/** Independent oracle: one verdict per check name, a pending one wins, then a pass, then all-skipped, else a failure. */
function reference(items: Item[]) {
  const groups = new Map<string, Verdict[]>();
  for (const i of items) groups.set(i.name, [...groups.get(i.name) ?? [], i.verdict]);
  const counts = { pass: 0, fail: 0, pending: 0, skipped: 0 };
  const failing: string[] = [];
  for (const [name, verdicts] of groups) {
    if (verdicts.includes('pending')) counts.pending++;
    else if (verdicts.includes('pass')) counts.pass++;
    else if (verdicts.every(v => v === 'skip')) counts.skipped++;
    else { counts.fail++; failing.push(name); }
  }
  failing.sort();
  const failed = items.filter(i => i.verdict === 'fail' && failing.includes(i.name));
  const runs = [...new Set(failed.flatMap(i => i.run === undefined ? [] : [i.run]))].sort((a, b) => a - b);
  const jobs = new Map<string, { name: string; url?: string }>();
  for (const i of failed) jobs.set(`${i.name}\n${url(i.run) ?? ''}`, { name: i.name, ...url(i.run) ? { url: url(i.run) } : {} });
  const failedJobs = [...jobs.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.url ?? '') < (b.url ?? '') ? -1 : (a.url ?? '') > (b.url ?? '') ? 1 : 0));
  const state = counts.pending ? 'pending' : counts.fail ? 'fail' : counts.pass ? 'pass' : 'none';
  return { state, ...counts, failing, runs, failedJobs };
}

test('checks summary matches an independent per-name oracle and does not depend on the order contexts arrive in', () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed);
    const items = randomItems(next, Math.floor(next() * 8));
    const contexts = items.map(spell);
    const summary = summarizeChecks(contexts);
    assert.deepEqual(summary, reference(items), `seed ${seed}: summary differs from the per-name oracle`);
    for (let k = 0; k < 3; k++) {
      assert.deepEqual(summarizeChecks(shuffle(next, contexts)), summary, `seed ${seed}: the order of contexts changed the summary`);
    }
  }
});

test('required checks with no context on the head are named, with the runs to rerun; a full page never claims one is missing', () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed);
    const full = next() < 0.1;
    const items: Item[] = full
      ? Array.from({ length: CONTEXTS_PAGE }, (_, i) => item(next, `c${i}`, 'pass', pick(next, RUNS)))
      : randomItems(next, Math.floor(next() * 6));
    const protectedNames = Array.from({ length: Math.floor(next() * 4) }, () => pick(next, [...NAMES, 'deploy']));
    const ruleNames = Array.from({ length: Math.floor(next() * 3) }, () => pick(next, [...NAMES, 'deploy']));
    // Branch protection is unreadable without admin rights (null): then only the rulesets name required checks.
    const hasProtection = next() >= 0.3;
    const raw: RawPullRequest = {
      ...pr(7), commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: items.map(spell) } } } }] },
      baseRef: {
        branchProtectionRule: hasProtection ? { requiredStatusCheckContexts: protectedNames } : null,
        rules: { nodes: [{ type: 'REQUIRED_STATUS_CHECKS', parameters: { requiredStatusChecks: ruleNames.map(context => ({ context })) } }] },
      },
    };
    const reported = new Set(items.map(i => i.name));
    const required = [...hasProtection ? protectedNames : [], ...ruleNames];
    const missing = full ? [] : [...new Set(required)].filter(n => !reported.has(n)).sort();
    const got = normalize(raw);
    assert.deepEqual(got.missingRequired, missing.length ? missing : undefined, `seed ${seed}: missing required checks`);
    const runs = [...new Set(items.flatMap(i => i.run === undefined ? [] : [i.run]))].sort((a, b) => a - b);
    assert.deepEqual(got.headRuns, missing.length ? runs : undefined, `seed ${seed}: runs to rerun`);
  }
});

const CHECK_SETS: Record<'pass' | 'fail' | 'pending' | 'none', Check[]> = {
  pass: [['test', 'COMPLETED', 'SUCCESS']],
  fail: [['test', 'COMPLETED', 'FAILURE']],
  pending: [['test', 'IN_PROGRESS']],
  none: [],
};

test('auto-merge stall: one event per continuous passing period of a head, only past the threshold, per an independent timeline model', () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed);
    let now = 1_000_000_000;
    let prev: Snapshot | undefined;
    let model: { head: string; since: number; reported: boolean } | undefined;
    const steps = 4 + Math.floor(next() * 40);
    for (let step = 0; step < steps; step++) {
      now += pick(next, [0, 30_000, 4 * 60_000, 6 * 60_000, 11 * 60_000]);
      const head = pick(next, ['a', 'b']), kind = pick(next, ['pass', 'pass', 'pending', 'fail'] as const);
      const auto = next() < 0.8, state = pick(next, ['OPEN', 'OPEN', 'OPEN', 'MERGED'] as const);
      const passing = state === 'OPEN' && auto && kind === 'pass';
      const raw = pr(9, {
        headRefOid: head.repeat(40), autoMergeRequest: auto ? {} : null, state,
        ...(state === 'MERGED' ? { mergeCommit: { oid: 'cafe00112233' } } : {}),
      }, CHECK_SETS[kind]);
      if (!passing) model = undefined;
      else if (!model || model.head !== head) model = { head, since: now, reported: false };
      const due = model !== undefined && !model.reported && now - model.since >= AUTO_MERGE_STALL_MS;
      if (model && due) model.reported = true;
      const r = autoMergeStall(prev, normalize(raw), now);
      assert.equal(r.event !== undefined, due, `seed ${seed} step ${step}: stall event`);
      if (r.event) assert.deepEqual([r.event.kind, r.event.wake, r.event.pr], ['stall', true, 9], `seed ${seed} step ${step}`);
      assert.equal(r.snapshot.passedAt, passing ? model?.since : undefined, `seed ${seed} step ${step}: passing clock`);
      assert.equal(r.snapshot.stallReported, passing ? model?.reported : undefined, `seed ${seed} step ${step}: reported flag`);
      prev = r.snapshot;
    }
  }
});

test('branch CI: a finished baseline is silent; each commit wakes once when its CI finishes, and never again after a poll', () => {
  const CI: Record<'pass' | 'fail' | 'pending' | 'none', RawCommit['statusCheckRollup']> = {
    pass: { contexts: { nodes: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }] } },
    fail: { contexts: { nodes: [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] } },
    pending: { contexts: { nodes: [{ __typename: 'CheckRun', name: 'test', status: 'IN_PROGRESS', conclusion: null }] } },
    none: { contexts: { nodes: [] } },
  };
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed);
    let prev: BranchSnapshot | undefined;
    let model: { head: string; reported: boolean } | undefined;
    const steps = 2 + Math.floor(next() * 30);
    for (let step = 0; step < steps; step++) {
      const head = pick(next, ['1', '2', '3']), kind = pick(next, ['pass', 'fail', 'pending', 'none'] as const);
      const cur = normalizeBranch('feature', { oid: head.repeat(40), messageHeadline: `commit ${head}`, statusCheckRollup: CI[kind] });
      const final = kind === 'pass' || kind === 'fail';
      let wakes = false;
      if (!model) model = { head: cur.head, reported: final };
      else {
        const reported = model.head === cur.head && model.reported;
        wakes = !reported && final;
        model = { head: cur.head, reported: reported || final };
      }
      const r = branchDiff(prev, cur);
      const checkEvents = r.events.filter(e => e.kind === 'checks');
      assert.equal(checkEvents.length, wakes ? 1 : 0, `seed ${seed} step ${step}: CI wake for ${head}/${kind}`);
      if (wakes) assert.equal(checkEvents[0].wake, true, `seed ${seed} step ${step}`);
      assert.equal(r.snapshot.reported, model.reported, `seed ${seed} step ${step}: reported flag`);
      prev = r.snapshot;
    }
  }
});

test('routing: a confirmation already given on this head is not a second wake; a failure, a conflict or a new head makes the next one news', () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed);
    let prev: Snapshot | undefined;
    let announced: Announced | undefined;
    // The oracle's own memory of what each slot last told the agent; it moves only on wakes.
    const told: { checks?: string; mergeState?: string } = {};
    const steps = 3 + Math.floor(next() * 30);
    for (let step = 0; step < steps; step++) {
      const head = pick(next, ['a', 'b']), kind = pick(next, ['pass', 'pass', 'fail', 'pending', 'none'] as const);
      const raw = pr(9, {
        headRefOid: head.repeat(40), autoMergeRequest: next() < 0.3 ? {} : null, isDraft: next() < 0.1,
        mergeStateStatus: pick(next, ['CLEAN', 'CLEAN', 'BLOCKED', 'DIRTY', 'BEHIND', 'UNKNOWN']),
        reviewDecision: pick(next, [null, null, 'APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']),
      }, CHECK_SETS[kind]);
      const cur = settle(prev, normalize(raw));
      if (!prev) { prev = cur; continue; }
      for (const event of diff(prev, cur)) {
        const decision = routeEvent(event, { cur, announced });
        const confirm = event.kind === 'checks' && cur.checks.state === 'pass' ? { slot: 'checks' as const, value: `pass@${cur.head}` }
          : event.kind === 'mergeState' && cur.mergeState === 'CLEAN' && !cur.auto && !cur.draft ? { slot: 'mergeState' as const, value: `CLEAN@${cur.head}` }
            : undefined;
        const repeated = confirm !== undefined && told[confirm.slot] === confirm.value;
        const expected = !event.wake || repeated ? 'candidate' : 'respond';
        assert.equal(decision.route, expected, `seed ${seed} step ${step}: ${event.kind} "${event.text}" routed ${decision.route} (${decision.reason})`);
        if (decision.route === 'respond') {
          if (event.kind === 'checks') told.checks = `${cur.checks.state}@${cur.head}`;
          if (event.kind === 'mergeState') told.mergeState = `${cur.mergeState}@${cur.head}`;
          announced = announce(announced, event, cur);
        }
      }
      prev = cur;
    }
  }
});
