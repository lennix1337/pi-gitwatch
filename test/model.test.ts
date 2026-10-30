import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diff, hint, line, normalize, settle, summarizeChecks } from '../src/model.ts';
import { pr } from './fixtures.ts';

const ctx = (name: string, status: string, conclusion: string | null = null) => ({ __typename: 'CheckRun', name, status, conclusion });

test('a cancelled duplicate next to a passing twin is not a failure', () => {
  const c = summarizeChecks([ctx('test', 'COMPLETED', 'SUCCESS'), ctx('test', 'COMPLETED', 'CANCELLED'), ctx('rust', 'COMPLETED', 'SKIPPED')]);
  assert.deepEqual(c, { state: 'pass', pass: 1, fail: 0, pending: 0, skipped: 1, failing: [] });
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
