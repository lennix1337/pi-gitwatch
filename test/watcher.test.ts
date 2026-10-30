import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAILURES_BEFORE_NOTICE, statusText, Store, Watcher } from '../src/watcher.ts';
import { FakeGitHub, pr, tempDir } from './fixtures.ts';

const setup = () => {
  const gh = new FakeGitHub();
  let clock = Date.UTC(2026, 9, 30, 16, 50);
  const watcher = new Watcher(new Store(tempDir()), gh.run, () => clock);
  return { gh, watcher, tick: () => { clock += 30_000; } };
};

test('a new watch is a silent baseline; a finished check wakes once', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(750, {}, [['test', 'IN_PROGRESS']]), pr(751, { mergeStateStatus: 'DIRTY' }));
  await watcher.watch('o/r', undefined);
  assert.equal((await watcher.poll()).notices.length, 0);
  gh.set(pr(750, { autoMergeRequest: {} }));
  const { notices } = await watcher.poll();
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /^\[gitwatch\] o\/r · 13:50\n#750 checks passed 1\/1\n  #750 BLOCKED/);
  assert.match(notices[0].text, /not a user instruction/);
  assert.doesNotMatch(notices[0].text, /#751/);
  assert.equal((await watcher.poll()).notices.length, 0, 'the same state is not announced twice');
});

test('a merge is reported once and the PR is dropped; a list watch ends with its last PR', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(1), pr(2));
  await watcher.watch('o/r', [1]);
  gh.set(pr(1, { state: 'MERGED', mergeCommit: { oid: 'abcdef123456' } }));
  const { notices } = await watcher.poll();
  assert.match(notices[0].text, /#1 merged abcdef12\n  #1 MERGED abcdef12/);
  assert.deepEqual(watcher.state().repos, {});
  assert.match(statusText(watcher.state(), new Map(), undefined, 0), /^No repositories watched/);
});

test('an open watch picks up new PRs without waking for them alone, and unwatched PRs stay out', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(1));
  await watcher.watch('o/r', undefined);
  gh.set(pr(2, {}, [['test', 'QUEUED']]));
  const first = await watcher.poll();
  assert.equal(first.notices.length, 0);
  assert.deepEqual(first.events.get('o/r')!.map(e => [e.pr, e.kind]), [[2, 'opened']]);
  await watcher.unwatch('o/r', [2]);
  gh.set(pr(2, { mergeStateStatus: 'DIRTY' }));
  assert.equal((await watcher.poll()).notices.length, 0);
  assert.deepEqual(Object.keys(watcher.state().repos['o/r'].snapshots), ['1']);
});

test('a watch on a missing PR fails before saving anything', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(1));
  await assert.rejects(watcher.watch('o/r', [1, 9]), /Not found in o\/r: #9/);
  assert.deepEqual(watcher.state().repos, {});
});

test('repeated poll failures are reported once, then recovery is silent', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(1));
  await watcher.watch('o/r', undefined);
  gh.fail = 'HTTP 502';
  const notices = [];
  for (let i = 0; i < FAILURES_BEFORE_NOTICE + 2; i++) notices.push(...(await watcher.poll()).notices);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /Polling failed 3 times in a row: HTTP 502/);
  assert.match(statusText(watcher.state(), new Map(), 'o/r', 0), /last poll failed \(5x\): HTTP 502/);
  gh.fail = undefined;
  assert.equal((await watcher.poll()).notices.length, 0);
  assert.doesNotMatch(statusText(watcher.state(), new Map(), 'o/r', 0), /last poll failed/);
});

test('status aggregates first, one line per PR with its next step', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(1, { mergeStateStatus: 'DIRTY' }), pr(2, {}, [['test', 'COMPLETED', 'FAILURE']]), pr(3, { mergeStateStatus: 'CLEAN' }));
  await watcher.watch('o/r', undefined);
  const text = statusText(watcher.state(), new Map(), 'o/r', 0);
  assert.match(text, /^o\/r · 3 open \(all open PRs\), 1 failing, 0 running, 1 conflicting, 1 clean · polled 13:50/);
  assert.match(text, /#1 DIRTY[^\n]*\n  next: merge the base branch/);
  assert.match(text, /#2 BLOCKED[^\n]*\n  next: read the failing job log: gh pr checks 2 --repo o\/r/);
  assert.match(text, /#3 CLEAN[^\n]*\n  next: ready to merge/);
  assert.match(statusText(watcher.state(), new Map(), 'x/y', 0), /^x\/y is not watched/);
});
