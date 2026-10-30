import assert from 'node:assert/strict';
import { test } from 'node:test';
import extension, { Lease, MESSAGE_TYPE } from '../src/index.ts';
import { Store } from '../src/watcher.ts';
import { commit, FakeGitHub, pr, tempDir } from './fixtures.ts';

type Handler = (event: unknown, ctx: { mode: string; cwd?: string; hasUI?: boolean; ui?: { notify: (text: string) => void } }) => unknown;
function harness(mode = 'tui', dir = tempDir(), send?: () => void | Promise<void>) {
  const gh = new FakeGitHub();
  const handlers = new Map<string, Handler>();
  const sent: { message: { customType: string; content: string }; options: unknown }[] = [];
  const timers: (() => void)[] = [];
  const warnings: string[] = [];
  let tool: { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> } | undefined;
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    registerTool: (t: typeof tool) => { tool = t; },
    sendMessage: (message: { customType: string; content: string }, options: unknown) => { sent.push({ message, options }); return send?.(); },
  };
  extension(pi as never, { run: gh.run, git: async args => args[0] === 'remote' ? 'https://github.com/o/r.git' : 'main', store: new Store(dir), schedule: fn => { timers.push(fn); return timers.length; }, cancel: () => {} });
  handlers.get('session_start')!({}, { mode, hasUI: true, ui: { notify: text => warnings.push(text) } });
  const call = (params: Record<string, unknown>) => tool!.execute('id', params, undefined, undefined, {});
  /** Runs the scheduled poll and waits for it to settle. */
  const fire = async () => { const fn = timers.shift(); assert.ok(fn, 'a poll is scheduled'); await fn(); };
  return { gh, sent, timers, call, fire, handlers, dir, warnings };
}

test('a watched PR whose checks finish wakes the session with a steer message', async () => {
  const h = harness();
  h.gh.set(pr(750, {}, [['test', 'IN_PROGRESS']]));
  const reply = await h.call({ action: 'watch', repo: 'o/r', prs: [750] });
  assert.equal(reply.isError, undefined);
  assert.match(reply.content[0].text, /^o\/r · 1 open \(listed: #750\), 0 failing, 1 running/);
  h.gh.set(pr(750, { mergeStateStatus: 'CLEAN' }));
  await h.fire();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].message.customType, MESSAGE_TYPE);
  assert.match(h.sent[0].message.content, /#750 checks passed 1\/1; mergeable \(CLEAN\)[\s\S]*next: ready to merge/);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: 'steer' });
  assert.equal(h.timers.length, 1, 'polling continues');
});

test('delivery waits for host acceptance before recording it or scheduling another poll', async () => {
  let accept!: () => void, entered!: () => void;
  const pending = new Promise<void>(r => { accept = r; });
  const started = new Promise<void>(r => { entered = r; });
  const h = harness('tui', tempDir(), () => { entered(); return pending; });
  h.gh.set(pr(1, {}, [['test', 'IN_PROGRESS']]));
  await h.call({ action: 'watch', repo: 'o/r', prs: [1] });
  h.gh.set(pr(1, { mergeStateStatus: 'CLEAN' }));
  const fired = h.fire();
  await started;
  try { assert.equal(h.timers.length, 0, 'do not finish the tick before the host accepts'); }
  finally { accept(); await fired; }
  const status = (await h.call({})).content[0].text;
  assert.match(status, /Host accepted: 1 wake requests, 0 next-turn notices; 0 uncertain/);
  assert.match(status, /not model runs or saved turns/);
  assert.doesNotMatch(status, /notices woke you/);
});

test('shutdown during an awaited send records its outcome but starts no further delivery or poll', async () => {
  let accept!: () => void, entered!: () => void;
  const pending = new Promise<void>(r => { accept = r; });
  const started = new Promise<void>(r => { entered = r; });
  const h = harness('tui', tempDir(), () => { entered(); return pending; });
  h.gh.set(pr(1, {}, [['test', 'IN_PROGRESS']]));
  await h.call({ action: 'watch', repo: 'o/r', prs: [1] });
  h.gh.set(pr(2, {}, [['test', 'IN_PROGRESS']]));
  await h.call({ action: 'watch', repo: 'o/s', prs: [2] });
  h.gh.set(pr(1, { mergeStateStatus: 'CLEAN' }), pr(2, { mergeStateStatus: 'CLEAN' }));
  const fired = h.fire();
  await started;
  h.handlers.get('session_shutdown')!({}, { mode: 'tui' });
  accept(); await fired;
  assert.equal(h.sent.length, 1);
  assert.equal(h.timers.length, 0);
  assert.equal(new Store(h.dir).load().deliveries?.wakeAccepted, 1);
});

test('sync throws and async rejections stay uncertain, are not replayed, and do not stop other notices', async () => {
  for (const failure of [() => { throw new Error('host rejected'); }, () => Promise.reject(new Error('host rejected'))]) {
    let attempts = 0;
    const h = harness('tui', tempDir(), () => { if (++attempts === 1) return failure(); });
    h.gh.set(pr(1, {}, [['test', 'IN_PROGRESS']]));
    await h.call({ action: 'watch', repo: 'o/r', prs: [1] });
    h.gh.set(pr(2, {}, [['test', 'IN_PROGRESS']]));
    await h.call({ action: 'watch', repo: 'o/s', prs: [2] });
    h.gh.set(pr(1, { mergeStateStatus: 'CLEAN' }), pr(2, { mergeStateStatus: 'CLEAN' }));
    await h.fire();
    assert.equal(h.sent.length, 2, 'a rejected first send does not drop the second repository');
    assert.equal(h.timers.length, 1);
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /delivery is uncertain.*Inspect session activity.*no automatic replay/);
    const status = (await h.call({})).content[0].text;
    assert.match(status, /Host accepted: 1 wake requests, 0 next-turn notices; 1 uncertain \(no automatic replay\)/);
    await h.fire();
    assert.equal(h.sent.length, 2, 'an uncertain dispatch is not retried');
    assert.equal(h.warnings.length, 1, 'the failure is reported once');
  }
});

test('status refreshes now and shows the change instead of announcing it later', async () => {
  const h = harness();
  h.gh.set(pr(1, {}, [['test', 'IN_PROGRESS']]));
  await h.call({ action: 'watch', repo: 'o/r' });
  h.gh.set(pr(1, {}, [['test', 'COMPLETED', 'FAILURE']]));
  const status = await h.call({});
  assert.match(status.content[0].text, /changed since last poll: #1 checks failed: test/);
  await h.fire();
  assert.equal(h.sent.length, 0);
  assert.match(status.content[0].text, /Routing decisions \(all repos\)/);
  assert.match(status.content[0].text, /Host delivery: not measured yet/);
});

test('subagent and one-shot sessions never poll; the lease keeps one poller per machine', async () => {
  const child = harness('json');
  assert.equal(child.timers.length, 0);
  const dir = tempDir();
  assert.equal(new Lease(dir, process.pid).acquire(1000, 90_000), true);
  assert.equal(new Lease(dir, process.ppid).acquire(2000, 90_000), false, 'a live holder with a fresh lease keeps it');
  assert.equal(new Lease(dir, process.ppid).acquire(100_000, 90_000), true, 'a stale lease is taken over');
});

test('invalid input fails before any GitHub call, with a corrective hint', async () => {
  const h = harness();
  for (const [params, pattern] of [
    [{ action: 'watch' }, /watch needs repo/],
    [{ action: 'watch', repo: 'not a repo' }, /repo must be owner\/name/],
    [{ action: 'status', prs: [1] }, /status accepts only repo/],
    [{ action: 'merge', repo: 'o/r' }, /Unknown action merge/],
    [{ action: 'watch', repo: 'o/r', prs: [1], branch: 'main' }, /prs or branch, not both/],
    [{ action: 'status', branch: 'main' }, /status accepts only repo/],
  ] as const) {
    const r = await h.call(params);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, pattern);
    assert.match(r.content[0].text, /Nothing on GitHub was changed/);
  }
  assert.equal(h.gh.calls.length, 0);
  assert.match((await h.call({})).content[0].text, /^No repositories watched/);
});

test('shutdown stops polling and releases the lease', async () => {
  const h = harness();
  h.gh.set(pr(1));
  await h.call({ action: 'watch', repo: 'o/r' });
  await h.fire();
  h.handlers.get('session_shutdown')!({}, { mode: 'tui' });
  assert.equal(new Lease(h.dir, process.ppid).acquire(Date.now(), 90_000), true);
});

test('a successful push or gh pr create in bash starts a watch and says so in the output', async () => {
  const h = harness();
  h.gh.set(pr(5, {}, [['test', 'QUEUED']]));
  h.gh.branches.set('main', commit('e5', [['test', 'QUEUED']]));
  const onResult = h.handlers.get('tool_result')!;
  const bash = (command: string, text = '', isError = false) =>
    onResult({ toolName: 'bash', input: { command }, content: [{ type: 'text', text }], isError }, { mode: 'tui', cwd: '/w' }) as Promise<{ content: { text: string }[] } | undefined>;
  const pushed = await bash('cd /w/dotfiles && git push -q origin main');
  assert.match(pushed!.content.at(-1)!.text, /^\[gitwatch\] now following o\/r main CI: you are woken when CI finishes/);
  assert.deepEqual(Object.keys(new Store(h.dir).load().repos['o/r'].branches!), ['main']);
  const created = await bash('gh pr create --fill', 'https://github.com/o/r/pull/5\n');
  assert.match(created!.content.at(-1)!.text, /now following o\/r #5/);
  assert.equal(await bash('git push origin main', 'rejected', true), undefined, 'a failed command is not followed');
  assert.equal(await bash('git status'), undefined);
  h.gh.fail = 'HTTP 502';
  assert.match((await bash('gh pr create --fill', 'https://github.com/o/r/pull/5\n'))!.content.at(-1)!.text, /could not start following o\/r #5: HTTP 502/);
  const child = harness('json');
  assert.equal(await child.handlers.get('tool_result')!({ toolName: 'bash', input: { command: 'git push' }, content: [], isError: false }, { mode: 'json' }), undefined, 'a non-polling session never watches');
});

test('a merge queued with auto-merge is recorded for the next turn without waking; an awaited one wakes', async () => {
  const h = harness();
  h.gh.set(pr(31, { autoMergeRequest: {} }, [['test', 'IN_PROGRESS']]), pr(32, { autoMergeRequest: {} }, [['test', 'IN_PROGRESS']]));
  await h.call({ action: 'watch', repo: 'o/r', prs: [31] });
  await h.call({ action: 'watch', repo: 'o/r', prs: [32], awaitMerge: true });
  h.gh.set(pr(31, { state: 'MERGED', autoMergeRequest: {}, mergeCommit: { oid: 'cf5d0007aaaa' } }));
  await h.fire();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /#31 merged cf5d0007/);
  assert.deepEqual(h.sent[0].options, { deliverAs: 'nextTurn' }, 'no model turn for the expected outcome');
  h.gh.set(pr(32, { state: 'MERGED', autoMergeRequest: {}, mergeCommit: { oid: 'dddd0000aaaa' } }));
  await h.fire();
  assert.deepEqual(h.sent[1].options, { triggerTurn: true, deliverAs: 'steer' }, 'work waits on #32: it wakes');
  const status = await h.call({ action: 'status' });
  assert.match(status.content[0].text, /No repositories watched/);
  assert.match(status.content[0].text, /Host accepted: 1 wake requests, 1 next-turn notices; 0 uncertain/);
  assert.equal((await h.call({ action: 'watch', repo: 'o/r', awaitMerge: true })).isError, true, 'awaitMerge needs prs');
});
