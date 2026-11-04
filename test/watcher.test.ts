import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { type Runner, query } from '../src/github.ts';
import type { RawPullRequest } from '../src/model.ts';
import { FAILURES_BEFORE_NOTICE, statusText, Store, Watcher, watchPush } from '../src/watcher.ts';
import { commit, FakeGitHub, pr, tempDir } from './fixtures.ts';

const setup = () => {
  const gh = new FakeGitHub();
  let clock = Date.UTC(2026, 9, 30, 16, 50);
  const watcher = new Watcher(new Store(tempDir()), gh.run, () => clock);
  return { gh, watcher, tick: () => { clock += 30_000; } };
};

test('delivery evidence survives reload without upgrading legacy routing counts', async () => {
  const { watcher } = setup();
  const legacy = { ...watcher.state(), stats: { since: Date.UTC(2026, 9, 1), woke: 99, quiet: 80 } };
  watcher.store.save(legacy);
  assert.match(statusText(legacy, new Map(), undefined, 0), /Host delivery: not measured yet/);
  await Promise.all([watcher.recordDelivery(true, true), watcher.recordDelivery(false, true), watcher.recordDelivery(true, false)]);
  const reloaded = new Watcher(new Store(watcher.store.dir), watcher.run).state();
  assert.deepEqual(reloaded.deliveries, { since: Date.UTC(2026, 9, 30, 16, 50), wakeAccepted: 1, quietAccepted: 1, uncertain: 1 });
  const text = statusText(reloaded, new Map(), 'o/absent', 0);
  assert.match(text, /99 wake, 80 next-turn; not delivery evidence/);
  assert.match(text, /Host accepted: 1 wake requests, 1 next-turn notices; 1 uncertain/);
  assert.match(text, /all repos/);
});

test('a state file with a missing or unknown watch shape is repaired on load so polling failures still reach the agent', async () => {
  const { gh, watcher } = setup();
  const raw = { version: 1, intervalSec: 30, repos: { 'o/r': { mode: 'open', snapshots: {} }, 'o/bad': { mode: 'paused', prs: [], snapshots: {}, failures: 0 } } };
  writeFileSync(join(watcher.store.dir, 'state.json'), JSON.stringify(raw));
  assert.deepEqual(Object.keys(watcher.state().repos), ['o/r'], 'an unknown mode is dropped');
  assert.equal(watcher.state().repos['o/r'].failures, 0);
  gh.fail = 'HTTP 502';
  const notices = [];
  for (let i = 0; i < FAILURES_BEFORE_NOTICE; i++) notices.push(...(await watcher.poll()).notices);
  assert.equal(notices.length, 1, 'the third failure in a row is announced');
});

test('a new watch is a silent baseline; a finished check wakes once', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(750, {}, [['test', 'IN_PROGRESS']]), pr(751, { mergeStateStatus: 'DIRTY' }));
  await watcher.watch('o/r');
  assert.equal((await watcher.poll()).notices.length, 0);
  gh.set(pr(750));
  const { notices } = await watcher.poll();
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /^\[gitwatch\] o\/r · 13:50\n#750 checks passed 1\/1\n  #750 BLOCKED/);
  assert.match(notices[0].text, /grants no permission/);
  assert.match(notices[0].text, /earlier operator order already covers it/);
  assert.doesNotMatch(notices[0].text, /#751/);
  assert.equal((await watcher.poll()).notices.length, 0, 'the same state is not announced twice');
});

test('a merge is reported once and the PR is dropped; a list watch ends with its last PR', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(1), pr(2));
  await watcher.watch('o/r', { prs: [1] });
  gh.set(pr(1, { state: 'MERGED', mergeCommit: { oid: 'abcdef123456' } }));
  const { notices } = await watcher.poll();
  assert.match(notices[0].text, /#1 merged abcdef12\n  #1 MERGED abcdef12/);
  assert.deepEqual(watcher.state().repos, {});
  assert.match(statusText(watcher.state(), new Map(), undefined, 0), /^No repositories watched/);
});

test('an open watch picks up new PRs without waking for them alone, and unwatched PRs stay out', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(1));
  await watcher.watch('o/r');
  gh.set(pr(2, {}, [['test', 'QUEUED']]));
  const first = await watcher.poll();
  assert.equal(first.notices.length, 0);
  assert.deepEqual(first.events.get('o/r')!.map(e => [e.pr, e.kind]), [[2, 'opened']]);
  await watcher.unwatch('o/r', [2]);
  gh.set(pr(2, { mergeStateStatus: 'DIRTY' }));
  assert.equal((await watcher.poll()).notices.length, 0);
  assert.deepEqual(Object.keys(watcher.state().repos['o/r'].snapshots), ['1']);
});

test('a PR added to an open watch is forgotten after its merge, not announced as opened on every poll', async () => {
  const { gh, watcher, tick } = setup();
  gh.set(pr(1), pr(5));
  await watcher.watch('o/r');
  await watcher.watch('o/r', { prs: [5] });
  gh.set(pr(1), pr(5, { state: 'MERGED', mergeCommit: { oid: 'abcdef123456' } }));
  const merged = await watcher.poll();
  assert.deepEqual(merged.events.get('o/r')!.map(e => [e.pr, e.kind]), [[5, 'merged']]);
  assert.deepEqual(watcher.state().repos['o/r'].prs, [], 'the merged PR leaves the watch list');
  for (let i = 0; i < 3; i++) {
    tick();
    const later = await watcher.poll();
    assert.deepEqual(later.events.get('o/r'), [], 'nothing new after the merge');
  }
  assert.equal(watcher.state().repos['o/r'].held, undefined);
});

test('a closed PR seen for the first time is not announced as opened', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(1));
  await watcher.watch('o/r');
  const state = watcher.state();
  state.repos['o/r'].prs = [7];
  watcher.store.save(state);
  gh.set(pr(1), pr(7, { state: 'MERGED' }));
  assert.deepEqual((await watcher.poll()).events.get('o/r'), []);
});

test('a watch on a missing PR fails before saving anything', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(1));
  await assert.rejects(watcher.watch('o/r', { prs: [1, 9] }), /Not found in o\/r: #9/);
  assert.deepEqual(watcher.state().repos, {});
});

test('repeated poll failures are reported once, then recovery is silent', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(1));
  await watcher.watch('o/r');
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
  await watcher.watch('o/r');
  const text = statusText(watcher.state(), new Map(), 'o/r', 0);
  assert.match(text, /^o\/r · 3 open \(all open PRs\), 1 failing, 0 running, 1 conflicting, 1 clean · polled 13:50/);
  assert.match(text, /#1 DIRTY[^\n]*\n  next: merge the base branch/);
  assert.match(text, /#2 BLOCKED[^\n]*\n  next: read the failing job log: gh pr checks 2 --repo o\/r/);
  assert.match(text, /#3 CLEAN[^\n]*\n  next: ready to merge/);
  assert.match(statusText(watcher.state(), new Map(), 'x/y', 0), /^x\/y is not watched/);
});

test('a branch watch reports its CI once, then ends; a list watch with nothing left is removed', async () => {
  const { gh, watcher } = setup();
  gh.branches.set('main', commit('c3', [['test', 'IN_PROGRESS']]));
  await watcher.watch('o/r', { branch: 'main' });
  assert.match(statusText(watcher.state(), new Map(), 'o/r', 0), /branch CI: main[\s\S]*\nmain @c3000000 · checks pending/);
  assert.equal((await watcher.poll()).notices.length, 0);
  gh.branches.set('main', commit('c3', [['test', 'COMPLETED', 'FAILURE']], 55));
  const { notices } = await watcher.poll();
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /\nmain checks failed: test\n  main @c3000000 [^\n]*\n  next: read the failing job log: gh run view 55 --repo o\/r --log-failed/);
  assert.deepEqual(watcher.state().repos, {});
  await assert.rejects(watcher.watch('o/r', { branch: 'gone' }), /Branch gone not found in o\/r/);
});

test('a push follows the branch PR when there is one, else the branch CI; an open watch already covers its PR', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(5, {}, [['test', 'QUEUED']]));
  gh.heads.set('feat/x', 5);
  gh.branches.set('main', commit('d4', []));
  assert.equal(await watchPush(watcher, 'o/r', 'feat/x'), 'o/r #5');
  assert.deepEqual(watcher.state().repos['o/r'].prs, [5]);
  assert.equal(await watchPush(watcher, 'o/r', 'main'), 'o/r main CI');
  assert.deepEqual(Object.keys(watcher.state().repos['o/r'].branches!), ['main']);
  await watcher.unwatch('o/r', undefined);
  await watcher.watch('o/r');
  assert.equal(await watchPush(watcher, 'o/r', 'feat/x'), 'o/r #5');
  assert.equal(watcher.state().repos['o/r'].mode, 'open');
});

test('a push to a branch with no PR costs one GitHub call: the head lookup also reads the branch CI', async () => {
  const { gh, watcher } = setup();
  gh.branches.set('feat/new', commit('e5', [['test', 'QUEUED']]));
  gh.calls.length = 0;
  assert.equal(await watchPush(watcher, 'o/r', 'feat/new'), 'o/r feat/new CI');
  assert.equal(gh.calls.length, 1, 'one GraphQL request, not a head lookup followed by a branch read');
  assert.equal(watcher.state().repos['o/r'].branches!['feat/new'].head, 'e5000000', 'the baseline is the branch head the lookup returned');
  assert.deepEqual(Object.keys(watcher.state().repos['o/r'].branches!), ['feat/new']);
  gh.calls.length = 0;
  await assert.rejects(watchPush(watcher, 'o/r', 'gone'), /Branch gone not found in o\/r/);
  assert.equal(gh.calls.length, 1, 'a missing branch is also answered by that single request');
});

test('auto-merge PRs stay quiet when checks pass and wake once if they do not merge', async () => {
  const { gh, watcher, tick } = setup();
  gh.set(pr(6, { autoMergeRequest: {} }, [['test', 'IN_PROGRESS']]));
  await watcher.watch('o/r');
  gh.set(pr(6, { autoMergeRequest: {} }));
  assert.equal((await watcher.poll()).notices.length, 0, 'checks passing with auto-merge on is not news');
  const woken = [];
  for (let i = 0; i < 25; i++) { tick(); woken.push(...(await watcher.poll()).notices); }
  assert.equal(woken.length, 1);
  assert.match(woken[0].text, /#6 auto-merge has not merged 10 min after checks passed \(BLOCKED\)[\s\S]*next: auto-merge is waiting/);
});

test('routing counts notices rather than events or model turns', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(1, { autoMergeRequest: {} }, [['test', 'IN_PROGRESS']]), pr(2, {}, [['test', 'IN_PROGRESS']]));
  await watcher.watch('o/r', { prs: [1, 2] });
  gh.set(pr(1, { state: 'MERGED', autoMergeRequest: {}, mergeCommit: { oid: 'abcdef123456' } }), pr(2, {}, [['test', 'COMPLETED', 'FAILURE']]));
  const { notices } = await watcher.poll();
  assert.deepEqual(notices.map(n => n.wake), [true], 'one repository, one notice: the failure wakes, the merge rides along');
  gh.set(pr(2, { state: 'MERGED', autoMergeRequest: {}, mergeCommit: { oid: 'bbbbbb123456' } }));
  assert.deepEqual((await watcher.poll()).notices.map(n => n.wake), [true], '#2 had no auto-merge when last seen');
  const state = watcher.state();
  assert.deepEqual([state.stats?.woke, state.stats?.quiet], [2, 0]);
});

test('an auto-merge finishing alone wakes, without claiming delivery evidence', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(5, { autoMergeRequest: {} }, [['test', 'IN_PROGRESS']]));
  await watcher.watch('o/r', { prs: [5] });
  gh.set(pr(5, { state: 'MERGED', autoMergeRequest: {}, mergeCommit: { oid: 'eeeeee123456' } }));
  const { notices } = await watcher.poll();
  assert.deepEqual(notices.map(n => [n.wake, /#5 merged eeeeee12/.test(n.text)]), [[true, true]]);
  assert.deepEqual([watcher.state().stats?.woke, watcher.state().stats?.quiet], [1, 0]);
  assert.match(statusText({ ...watcher.state(), repos: { 'o/r': { mode: 'open', prs: [], snapshots: {}, failures: 0 } } }, new Map(), undefined, 0), /1 wake, 0 next-turn; not delivery evidence/);
});

test('the clone a push came from rides on the merge notice with the merged head, even into an existing open watch', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(5, { autoMergeRequest: {} }, [['test', 'IN_PROGRESS']]));
  gh.heads.set('feat/x', 5);
  await watcher.watch('o/r');
  await watchPush(watcher, 'o/r', 'feat/x', 'C:/projetos/r');
  assert.equal(watcher.state().repos['o/r'].clone, 'C:/projetos/r');
  gh.set(pr(5, { state: 'MERGED', autoMergeRequest: {}, mergeCommit: { oid: 'eeeeee123456' } }));
  const { notices } = await watcher.poll();
  assert.equal(notices[0].clone, 'C:/projetos/r');
  assert.deepEqual(notices[0].events.filter(e => e.kind === 'merged').map(e => e.head), ['5aaaaaaa'], 'the short head a snapshot keeps; git resolves it');
});

/**
 * A runner that holds each GitHub read until `expected` of them are in flight (or a second passes), then answers like
 * FakeGitHub. A sequential poll never gets `expected` reads in flight, so its peak stays at one.
 */
function barrierRunner(gh: FakeGitHub, expected: number) {
  let inFlight = 0, peak = 0;
  const calls: string[][] = [];
  let release!: () => void;
  const everyone = new Promise<void>(resolve => { release = resolve; });
  const run: Runner = async (args, signal) => {
    calls.push(args);
    inFlight++;
    peak = Math.max(peak, inFlight);
    if (inFlight === expected) release();
    try {
      await Promise.race([everyone, new Promise(resolve => setTimeout(resolve, 1000))]);
      return await gh.run(args, signal);
    } finally {
      inFlight--;
    }
  };
  return { run, calls, peak: () => peak };
}

const repoNames = (count: number) => Array.from({ length: count }, (_, i) => `o/r${i}`);

test('a poll reads every watched repository at once, not one after another', async () => {
  const gh = new FakeGitHub();
  gh.set(pr(1));
  const dir = tempDir();
  const clock = () => Date.UTC(2026, 9, 30, 16, 50);
  const setup = new Watcher(new Store(dir), gh.run, clock);
  for (const repo of repoNames(3)) await setup.watch(repo, { prs: [1] });
  const barrier = barrierRunner(gh, 3);
  const { notices } = await new Watcher(new Store(dir), barrier.run, clock).poll();
  assert.equal(barrier.calls.length, 3, 'each watched repository is read once');
  assert.equal(barrier.peak(), 3, 'the three reads overlap');
  assert.equal(notices.length, 0);
});

test('a poll keeps at most four repository reads in flight, to stay within GitHub rate limits', async () => {
  const gh = new FakeGitHub();
  gh.set(pr(1));
  const dir = tempDir();
  const clock = () => Date.UTC(2026, 9, 30, 16, 50);
  const setup = new Watcher(new Store(dir), gh.run, clock);
  for (const repo of repoNames(6)) await setup.watch(repo, { prs: [1] });
  const barrier = barrierRunner(gh, 4);
  await new Watcher(new Store(dir), barrier.run, clock).poll();
  assert.equal(barrier.calls.length, 6);
  assert.equal(barrier.peak(), 4);
});

test('a failing repository is counted on its own while the others in the same poll still report', async () => {
  const gh = new FakeGitHub();
  gh.set(pr(1, {}, [['test', 'IN_PROGRESS']]));
  const dir = tempDir();
  const clock = () => Date.UTC(2026, 9, 30, 16, 50);
  const setup = new Watcher(new Store(dir), gh.run, clock);
  await setup.watch('o/good', { prs: [1] });
  await setup.watch('o/bad', { prs: [1] });
  gh.set(pr(1, {}, [['test', 'COMPLETED', 'FAILURE']]));
  const flaky: Runner = async (args, signal) => {
    if (args.includes('name=bad')) throw new Error('HTTP 502');
    return gh.run(args, signal);
  };
  const watcher = new Watcher(new Store(dir), flaky, clock);
  const notices = [];
  for (let i = 0; i < FAILURES_BEFORE_NOTICE; i++) notices.push(...(await watcher.poll()).notices);
  assert.deepEqual(notices.map(n => n.repo), ['o/good', 'o/bad']);
  assert.equal(notices[0].wake, true, 'the good repository woke the agent on its first poll');
  assert.match(notices[1].text, /o\/bad[\s\S]*Polling failed 3 times in a row: HTTP 502/);
  assert.equal(watcher.state().repos['o/good'].failures, 0);
  assert.equal(watcher.state().repos['o/bad'].failures, FAILURES_BEFORE_NOTICE);
});

/** A PR whose checks carry job links, as GitHub's rollup gives them: each job has its own run and job id. */
const jobsPr = (n: number, over: Partial<RawPullRequest>, jobs: { name: string; status: string; conclusion: string | null; run: number; job: number }[]) => pr(n, {
  ...over,
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: jobs.map(j => ({ __typename: 'CheckRun', name: j.name, status: j.status, conclusion: j.conclusion, detailsUrl: `https://github.com/o/r/actions/runs/${j.run}/job/${j.job}` })) } } } }] },
}, []);

test('a failing check names its job links in the notice, and status keeps them', async () => {
  const { gh, watcher, tick } = setup();
  gh.set(jobsPr(60, {}, [{ name: 'unit', status: 'IN_PROGRESS', conclusion: null, run: 60, job: 1 }, { name: 'e2e', status: 'IN_PROGRESS', conclusion: null, run: 60, job: 2 }]));
  await watcher.watch('o/r', { prs: [60] });
  tick();
  gh.set(jobsPr(60, { mergeStateStatus: 'BLOCKED' }, [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', run: 61, job: 3 }, { name: 'e2e', status: 'COMPLETED', conclusion: 'FAILURE', run: 61, job: 4 }]));
  const { notices } = await watcher.poll();
  assert.deepEqual(notices.map(n => n.wake), [true]);
  assert.match(notices[0].text, /#60 checks failed: e2e, unit\n {2}#60 BLOCKED · checks fail 0✓ 2✗ 0… \[e2e, unit\]/);
  assert.match(notices[0].text, /\n {2}jobs: e2e https:\/\/github\.com\/o\/r\/actions\/runs\/61\/job\/4 ; unit https:\/\/github\.com\/o\/r\/actions\/runs\/61\/job\/3\n/);
  assert.match(statusText(watcher.state(), new Map(), 'o/r', 0), /jobs: e2e https:\/\/github\.com\/o\/r\/actions\/runs\/61\/job\/4/);
});

test('a CI rerun that passes again on an announced head is a candidate, not a second turn', async () => {
  const { gh, watcher, tick } = setup();
  gh.set(pr(2, { mergeStateStatus: 'BLOCKED' }, [['test', 'IN_PROGRESS']]));
  await watcher.watch('o/r', { prs: [2] });
  gh.set(pr(2, { mergeStateStatus: 'CLEAN' }));
  assert.deepEqual((await watcher.poll()).notices.map(n => n.wake), [true], 'first pass: the agent hears it');
  gh.set(pr(2, { mergeStateStatus: 'BLOCKED' }, [['test', 'IN_PROGRESS']])); tick();
  assert.deepEqual((await watcher.poll()).notices, [], 'a rerun starts quietly');
  gh.set(pr(2, { mergeStateStatus: 'CLEAN' })); tick();
  assert.deepEqual((await watcher.poll()).notices, [], 'the same head is already known to the agent');
});

test('a quiet change waits for the next wake, is shown there once, and is not sent alone', async () => {
  const { gh, watcher, tick } = setup();
  gh.set(pr(3, { mergeStateStatus: 'CLEAN' }));
  await watcher.watch('o/r', { prs: [3] });
  gh.set(pr(3, { mergeStateStatus: 'BLOCKED' }, [['test', 'IN_PROGRESS']])); tick();
  assert.deepEqual((await watcher.poll()).notices, [], 'a quiet change is not sent by itself');
  assert.match(JSON.stringify(watcher.state().repos['o/r'].held), /checks running \(1 pending\)/);
  gh.set(pr(3, { mergeStateStatus: 'DIRTY' }, [['test', 'IN_PROGRESS']])); tick();
  const { notices } = await watcher.poll();
  assert.deepEqual(notices.map(n => n.wake), [true]);
  assert.match(notices[0].text, /#3 merge conflict with base \(DIRTY\)/);
  assert.match(notices[0].text, /since last notice: #3 checks running \(1 pending\)/);
  assert.equal(watcher.state().repos['o/r'].held, undefined);
  assert.deepEqual((await watcher.poll()).notices, [], 'shown once');
});

test('a held change older than 30 minutes goes out as a quiet notice, once', async () => {
  const { gh, watcher, tick } = setup();
  gh.set(pr(4, {}, [['test', 'COMPLETED', 'SUCCESS']]));
  await watcher.watch('o/r', { prs: [4] });
  gh.set(pr(4, {}, [['test', 'IN_PROGRESS']])); tick();
  assert.deepEqual((await watcher.poll()).notices, []);
  for (let i = 0; i < 61; i++) tick();
  const { notices } = await watcher.poll();
  assert.deepEqual(notices.map(n => n.wake), [false]);
  assert.match(notices[0].text, /since last notice: #4 checks running/);
  assert.deepEqual((await watcher.poll()).notices, []);
});

test('a status refresh that sees the merge drops what the PR held: no stale "checks passed" 30 minutes later', async () => {
  const { gh, watcher, tick } = setup();
  gh.set(pr(7, { autoMergeRequest: {} }, [['test', 'IN_PROGRESS']]), pr(8, {}, [['test', 'COMPLETED', 'SUCCESS']]));
  await watcher.watch('o/r', { prs: [7] });
  await watcher.watch('o/r', { prs: [8] });
  gh.set(pr(7, { autoMergeRequest: {}, mergeStateStatus: 'CLEAN' }, [['test', 'COMPLETED', 'SUCCESS']]), pr(8, {}, [['test', 'IN_PROGRESS']])); tick();
  assert.deepEqual((await watcher.poll()).notices, [], 'auto-merge PR passing stays quiet');
  assert.match(JSON.stringify(watcher.state().repos['o/r'].held), /#?7|"pr":7/);
  gh.set(pr(7, { state: 'MERGED', autoMergeRequest: {}, mergeCommit: { oid: 'cafe00112233' } }), pr(8, {}, [['test', 'IN_PROGRESS']])); tick();
  await watcher.poll(undefined, undefined, { deliver: false });
  for (let i = 0; i < 61; i++) tick();
  const { notices } = await watcher.poll();
  assert.ok(!notices.some(n => /#7/.test(n.text)), `no stale notice for merged #7: ${notices.map(n => n.text).join('|')}`);
  assert.match(notices.map(n => n.text).join('\n'), /#8 checks running/, 'an open PR\'s held change still ages out');
});

test('held changes are bounded: the oldest beyond 40 are counted, not kept, and the wake says so', async () => {
  const { gh, watcher, tick } = setup();
  const check = (n: number, status: string, conclusion: string | null) => pr(n, {}, [['test', status, conclusion]]);
  const nums = Array.from({ length: 45 }, (_, i) => i + 1);
  gh.set(...nums.map(n => check(n, 'COMPLETED', 'SUCCESS')), check(46, 'IN_PROGRESS', null));
  await watcher.watch('o/r', { prs: [...nums, 46] });
  gh.set(...nums.map(n => check(n, 'IN_PROGRESS', null))); tick();
  assert.deepEqual((await watcher.poll()).notices, [], 'forty-five quiet changes are held');
  gh.set(check(46, 'COMPLETED', 'FAILURE')); tick();
  const { notices } = await watcher.poll();
  assert.deepEqual(notices.map(n => n.wake), [true]);
  assert.match(notices[0].text, /since last notice: .*\+32 more \(gitwatch \{"action":"status","repo":"o\/r"\}\); 5 earlier omitted/);
});

test('an auto-merge finishing wakes and carries what waited for the next turn', async () => {
  const { gh, watcher, tick } = setup();
  gh.set(pr(5, {}, [['test', 'COMPLETED', 'SUCCESS']]), pr(6, { autoMergeRequest: {} }, [['test', 'IN_PROGRESS']]));
  await watcher.watch('o/r', { prs: [5] });
  await watcher.watch('o/r', { prs: [6] });
  gh.set(pr(5, {}, [['test', 'IN_PROGRESS']])); tick();
  assert.deepEqual((await watcher.poll()).notices, []);
  gh.set(pr(5, {}, [['test', 'IN_PROGRESS']]), pr(6, { state: 'MERGED', autoMergeRequest: {}, mergeCommit: { oid: 'cafe00112233' } })); tick();
  const { notices } = await watcher.poll();
  assert.deepEqual(notices.map(n => n.wake), [true]);
  assert.match(notices[0].text, /#6 merged cafe0011/);
  assert.match(notices[0].text, /since last notice: #5 checks running \(1 pending\)/);
});

test('a merge this session made itself is ignored: no notice, counted as ignored; another merge still wakes', async () => {
  const { gh, watcher, tick } = setup();
  gh.set(pr(70, { mergeStateStatus: 'CLEAN' }), pr(71, { mergeStateStatus: 'CLEAN' }), pr(72));
  await watcher.watch('o/r', { prs: [70, 71, 72] });
  assert.equal(await watcher.noteOwnMerge('o/r', 70), true);
  gh.set(pr(70, { state: 'MERGED', mergeCommit: { oid: 'aaaaaa123456' } }), pr(71, { state: 'MERGED', mergeCommit: { oid: 'bbbbbb123456' } }), pr(72)); tick();
  const { notices } = await watcher.poll();
  assert.deepEqual(notices.map(n => [n.wake, n.events.map(e => e.pr)]), [[true, [71]]], "#70 is the agent's own merge; #71 is not");
  const state = watcher.state();
  assert.deepEqual([state.routes?.respond, state.routes?.ignore], [1, 1]);
  assert.match(statusText(state, new Map(), undefined, 0), /1 respond, 0 candidate \(waits for the next notice\), 1 ignored \(merges the agent made itself; not sent\)/);
  assert.equal(state.repos['o/r'].ownMerges, undefined, 'a merge seen is no longer marked');
});

test('a PR the watch does not follow cannot be marked as merged by this session', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(73));
  await watcher.watch('o/r', { prs: [73] });
  assert.equal(await watcher.noteOwnMerge('o/r', 99), false);
  assert.equal(await watcher.noteOwnMerge('o/absent', 73), false);
  assert.equal(watcher.state().repos['o/r'].ownMerges, undefined);
});

test('the cleanup of a merge this session made is still done and reported, quietly', async () => {
  const { gh, watcher, tick } = setup();
  gh.set(pr(74, { mergeStateStatus: 'CLEAN' }), pr(75));
  await watcher.watch('o/r', { prs: [74, 75], clone: '/work/clone' });
  await watcher.noteOwnMerge('o/r', 74);
  gh.set(pr(74, { state: 'MERGED', mergeCommit: { oid: 'dddd00112233' } }), pr(75)); tick();
  const cleaned: string[] = [];
  const { notices } = await watcher.poll(undefined, undefined, {
    cleanup: async ({ clone, events }) => events.map(e => { cleaned.push(String(e.pr)); return { pr: e.pr, text: `deleted local branch feat/74 (${clone})` }; }),
  });
  assert.deepEqual(cleaned, ['74'], 'the merged PR was cleaned, even though its merge is not announced');
  assert.deepEqual(notices.map(n => n.wake), [false]);
  assert.match(notices[0].text, /since last notice: #74 deleted local branch feat\/74 \(\/work\/clone\)/);
});

test('a subscriber takes the notices of its PR; the others stay with this session', async () => {
  const { gh, watcher } = setup();
  gh.set(pr(80, {}, [['test', 'IN_PROGRESS']]), pr(81, {}, [['test', 'IN_PROGRESS']]));
  await watcher.watch('o/r', { prs: [80], subscriber: 'worker-1' });
  await watcher.watch('o/r', { prs: [81] });
  gh.set(pr(80, {}, [['test', 'COMPLETED', 'FAILURE']]), pr(81, {}, [['test', 'COMPLETED', 'FAILURE']]));
  const { notices } = await watcher.poll();
  assert.equal(notices.length, 2);
  const taken = notices.find(n => n.subscriber === 'worker-1');
  const kept = notices.find(n => n.subscriber === undefined);
  assert.deepEqual(taken?.events.map(e => e.pr), [80]);
  assert.deepEqual(kept?.events.map(e => e.pr), [81]);
  assert.match(statusText(watcher.state(), new Map(), 'o/r', 0), /#80 [^\n]*· for worker-1/);
  assert.deepEqual(watcher.state().repos['o/r'].subscribers, { 'pr:80': 'worker-1' });
  await watcher.unwatch('o/r', [80]);
  assert.equal(watcher.state().repos['o/r'].subscribers, undefined, 'a subscriber ends with its PR');
});

test('state written before failing-job links existed loads, and its failing PR still shows in status', async () => {
  const { gh, watcher } = setup();
  gh.set(jobsPr(90, {}, [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', run: 90, job: 1 }]));
  await watcher.watch('o/r', { prs: [90] });
  const file = join(watcher.store.dir, 'state.json');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  for (const s of Object.values(saved.repos['o/r'].snapshots) as { checks: Record<string, unknown> }[]) delete s.checks.failedJobs;
  writeFileSync(file, JSON.stringify(saved));
  const text = statusText(new Store(watcher.store.dir).load(), new Map(), 'o/r', 0);
  assert.match(text, /#90 BLOCKED · checks fail/);
  assert.doesNotMatch(text, /jobs:/);
});

test('the GraphQL query asks for each PR head branch, so a notice can name it', () => {
  assert.match(query([1], true), /headRefOid headRefName author/);
  assert.match(query([1], false), /headRefName/);
});

test('the GraphQL query asks for the required checks of each PR base, from branch protection and rulesets', () => {
  assert.match(query([1], false), /baseRef \{ branchProtectionRule \{ requiredStatusCheckContexts \}/);
  assert.match(query([1], false), /RequiredStatusChecksParameters \{ requiredStatusChecks \{ context \}/);
});

test('a held change of the same PR and kind is superseded by the wake that states it', async () => {
  const { gh, watcher, tick } = setup();
  gh.set(pr(13, {}, [['test', 'COMPLETED', 'SUCCESS']]));
  await watcher.watch('o/r', { prs: [13] });
  gh.set(pr(13, {}, [['test', 'IN_PROGRESS']])); tick();
  assert.deepEqual((await watcher.poll()).notices, []);
  gh.set(pr(13, {}, [['test', 'COMPLETED', 'FAILURE']])); tick();
  const { notices } = await watcher.poll();
  assert.deepEqual(notices.map(n => n.wake), [true]);
  assert.doesNotMatch(notices[0].text, /since last notice/, 'the failure already says what the running check became');
});
