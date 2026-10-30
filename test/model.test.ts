import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_MERGE_STALL_MS, autoMergeStall, branchDiff, branchHint, branchLine, diff, hint, line, normalize, normalizeBranch, settle, summarizeChecks } from '../src/model.ts';
import { commit, pr } from './fixtures.ts';

const ctx = (name: string, status: string, conclusion: string | null = null) => ({ __typename: 'CheckRun', name, status, conclusion });

test('a cancelled duplicate next to a passing twin is not a failure', () => {
  const c = summarizeChecks([ctx('test', 'COMPLETED', 'SUCCESS'), ctx('test', 'COMPLETED', 'CANCELLED'), ctx('rust', 'COMPLETED', 'SKIPPED')]);
  assert.deepEqual(c, { state: 'pass', pass: 1, fail: 0, pending: 0, skipped: 1, failing: [], runs: [] });
});

test('pending wins over a finished twin; failures are named; status contexts count', () => {
  assert.equal(summarizeChecks([ctx('test', 'COMPLETED', 'FAILURE'), ctx('test', 'IN_PROGRESS')]).state, 'pending');
  const c = summarizeChecks([ctx('b', 'COMPLETED', 'FAILURE'), ctx('a', 'COMPLETED', 'TIMED_OUT'), { __typename: 'StatusContext', context: 'ci/x', state: 'SUCCESS' }]);
  assert.deepEqual([c.state, c.failing, c.pass], ['fail', ['a', 'b'], 1]);
  assert.equal(summarizeChecks([]).state, 'none');
});

test('checks finishing wake the agent; starting does not', () => {
  const running = normalize(pr(1, {}, [['test', 'IN_PROGRESS']]));
  const passed = normalize(pr(1));
  const failed = normalize(pr(1, {}, [['test', 'COMPLETED', 'FAILURE']]));
  assert.deepEqual(diff(running, passed).map(e => [e.kind, e.text, e.wake]), [['checks', 'checks passed 1/1', true]]);
  assert.deepEqual(diff(running, failed).map(e => [e.text, e.wake]), [['checks failed: test', true]]);
  assert.deepEqual(diff(passed, running).map(e => e.wake), [false]);
  assert.deepEqual(diff(passed, passed), []);
});

test('conflict wakes; CLEAN wakes only without auto-merge; merge is terminal', () => {
  const blocked = normalize(pr(2));
  assert.equal(diff(blocked, normalize(pr(2, { mergeStateStatus: 'DIRTY' })))[0].wake, true);
  assert.equal(diff(blocked, normalize(pr(2, { mergeStateStatus: 'CLEAN' })))[0].wake, true);
  assert.equal(diff(blocked, normalize(pr(2, { mergeStateStatus: 'CLEAN', autoMergeRequest: {} })))
    .find(e => e.kind === 'mergeState')!.wake, false);
  const merged = diff(blocked, normalize(pr(2, { state: 'MERGED', mergeCommit: { oid: 'f3221ec1aaaa' } })));
  assert.deepEqual(merged.map(e => [e.kind, e.text, e.wake]), [['merged', 'merged f3221ec1', true]]);
});

test('UNKNOWN mergeability keeps the last known state on the same head', () => {
  const prev = normalize(pr(3, { mergeStateStatus: 'CLEAN' }));
  const cur = settle(prev, normalize(pr(3, { mergeStateStatus: 'UNKNOWN' })));
  assert.equal(cur.mergeState, 'CLEAN');
  assert.deepEqual(diff(prev, cur), []);
});

test('line and hint carry the decision fields', () => {
  const s = normalize(pr(4, { mergeStateStatus: 'DIRTY', title: 'fix: something' }, [['test', 'COMPLETED', 'FAILURE']]));
  assert.match(line(s), /^#4 DIRTY · checks fail 0✓ 1✗ 0… \[test\] · 4aaaaaaa · dev · "fix: something"$/);
  assert.match(hint(s, 'o/r')!, /conflict/);
  assert.equal(hint(normalize(pr(5, { mergeStateStatus: 'CLEAN' })), 'o/r'), 'ready to merge');
  assert.match(hint(normalize(pr(6, {}, [['t', 'COMPLETED', 'FAILURE']])), 'o/r')!, /gh pr checks 6 --repo o\/r/);
});

test('with auto-merge on, passing checks ride along; failing ones still wake', () => {
  const running = normalize(pr(7, { autoMergeRequest: {} }, [['test', 'IN_PROGRESS']]));
  assert.deepEqual(diff(running, normalize(pr(7, { autoMergeRequest: {} }))).map(e => [e.text, e.wake]), [['checks passed 1/1', false]]);
  assert.equal(diff(running, normalize(pr(7, { autoMergeRequest: {} }, [['test', 'COMPLETED', 'FAILURE']])))[0].wake, true);
});

test('failing checks name their Actions run and the hint gives the log command', () => {
  const url = (run: number) => `https://github.com/o/r/actions/runs/${run}/job/9`;
  const c = summarizeChecks([
    { ...ctx('lint', 'COMPLETED', 'FAILURE'), detailsUrl: url(42) }, { ...ctx('unit', 'COMPLETED', 'FAILURE'), detailsUrl: url(41) },
    { ...ctx('ok', 'COMPLETED', 'SUCCESS'), detailsUrl: url(40) }, { ...ctx('ok', 'COMPLETED', 'FAILURE'), detailsUrl: url(39) },
    { ...ctx('unit', 'COMPLETED', 'SKIPPED'), detailsUrl: url(43) }, { __typename: 'StatusContext', context: 'ext', state: 'FAILURE', targetUrl: 'https://ci.example/1' },
  ]);
  assert.deepEqual(c.runs, [41, 42], 'a rerun that passed, skipped twins and non-Actions URLs are not listed');
  const s = normalize(pr(8, {}, [['unit', 'COMPLETED', 'FAILURE']]));
  s.checks.runs = [41];
  assert.equal(hint(s, 'o/r'), 'read the failing job log: gh run view 41 --repo o/r --log-failed');
});

test('auto-merge that does not merge 10 min after checks passed wakes once, and a new head starts over', () => {
  const t0 = 1_000_000;
  const passing = normalize(pr(9, { autoMergeRequest: {} }));
  const first = autoMergeStall(undefined, passing, t0);
  assert.equal(first.event, undefined);
  assert.equal(autoMergeStall(first.snapshot, passing, t0 + AUTO_MERGE_STALL_MS - 1).event, undefined);
  const stalled = autoMergeStall(first.snapshot, passing, t0 + AUTO_MERGE_STALL_MS);
  assert.deepEqual([stalled.event?.text, stalled.event?.wake], ['auto-merge has not merged 10 min after checks passed (BLOCKED)', true]);
  assert.match(hint(stalled.snapshot, 'o/r')!, /auto-merge is waiting on a review or rule: gh pr view 9/);
  assert.equal(autoMergeStall(stalled.snapshot, passing, t0 + 3 * AUTO_MERGE_STALL_MS).event, undefined, 'reported once');
  const pushed = normalize(pr(9, { autoMergeRequest: {}, headRefOid: 'b'.repeat(40) }));
  assert.equal(autoMergeStall(stalled.snapshot, pushed, t0 + 3 * AUTO_MERGE_STALL_MS).snapshot.stallReported, false);
  assert.equal(autoMergeStall(undefined, normalize(pr(9)), t0).snapshot.passedAt, undefined, 'without auto-merge nothing is tracked');
});

test('branch CI: a finished baseline is silent; a new commit wakes once when its CI finishes', () => {
  const done = normalizeBranch('main', commit('a1'));
  assert.equal(branchDiff(undefined, done).snapshot.reported, true);
  const base = branchDiff(undefined, normalizeBranch('main', commit('a1', [['test', 'IN_PROGRESS']]))).snapshot;
  assert.equal(base.reported, false);
  const pushed = branchDiff(base, normalizeBranch('main', commit('b2', [['test', 'QUEUED']])));
  assert.deepEqual(pushed.events.map(e => [e.branch, e.text, e.wake]), [['main', 'new commit b2000000', false]]);
  const failed = branchDiff(pushed.snapshot, normalizeBranch('main', commit('b2', [['test', 'COMPLETED', 'FAILURE']], 77)));
  assert.deepEqual(failed.events.map(e => [e.text, e.wake]), [['checks failed: test', true]]);
  assert.equal(branchHint(failed.snapshot, 'o/r'), 'read the failing job log: gh run view 77 --repo o/r --log-failed');
  assert.match(branchLine(failed.snapshot), /^main @b2000000 · checks fail 0✓ 1✗ 0… \[test\] · CI finished, watch ends · "commit b2"$/);
  assert.deepEqual(branchDiff(failed.snapshot, normalizeBranch('main', commit('b2', [['test', 'COMPLETED', 'FAILURE']]))).events, []);
});
