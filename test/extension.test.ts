import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import extension, { Lease, MESSAGE_TYPE } from '../src/index.ts';
import { SUBSCRIBER_NOTICE_CHANNEL, type SubscriberNotice } from '../src/subscribers.ts';
import { gitRunner, type GitRunner } from '../src/autowatch.ts';
import { Store } from '../src/watcher.ts';
import { pendingFollows, requestFollow } from '../src/follow-requests.ts';
import { commit, FakeGitHub, gitWorld, pr, run, tempDir } from './fixtures.ts';

/** A quiet notice is appended to the session at once and starts no turn. A `nextTurn` message would be held until the operator's next message. */
const QUIET = { triggerTurn: false };

type Handler = (event: unknown, ctx: { mode: string; cwd?: string; hasUI?: boolean; ui?: { notify: (text: string, type?: string) => void } }) => unknown;
/** `git` answers the extension's git calls (default: a fake of o/r on main); `packages` are the loaded Pi packages (default: none, never the real settings). */
function harness(mode = 'tui', dir = tempDir(), send?: () => void | Promise<void>, over: { git?: GitRunner; packages?: string[] } = {}) {
  const gh = new FakeGitHub();
  const handlers = new Map<string, Handler>();
  const sent: { message: { customType: string; content: string; display?: boolean }; options: unknown }[] = [];
  const timers: (() => void)[] = [];
  const warnings: string[] = [];
  /** What the operator sees at once (ctx.ui.notify at 'info' level), in order with `sent`. */
  const shown: { text: string; sentBefore: number }[] = [];
  let tool: { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> } | undefined;
  // The shared extension bus: a subscriber listens on a channel and may take a notice it is addressed to.
  const bus = new Map<string, ((data: unknown) => void)[]>();
  const events = {
    emit: (channel: string, data: unknown) => { for (const h of bus.get(channel) ?? []) h(data); },
    on: (channel: string, h: (data: unknown) => void) => { bus.set(channel, [...bus.get(channel) ?? [], h]); return () => { bus.set(channel, (bus.get(channel) ?? []).filter(x => x !== h)); }; },
  };
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    registerTool: (t: typeof tool) => { tool = t; },
    sendMessage: (message: { customType: string; content: string }, options: unknown) => { sent.push({ message, options }); return send?.(); },
    events,
  };
  extension(pi as never, { run: gh.run, git: over.git ?? (async args => args[0] === 'remote' ? 'https://github.com/o/r.git' : 'main'), packages: () => over.packages ?? [], store: new Store(dir), schedule: fn => { timers.push(fn); return timers.length; }, cancel: () => {} });
  handlers.get('session_start')!({}, { mode, hasUI: true, ui: { notify: (text, type) => { if (type === 'info') shown.push({ text, sentBefore: sent.length }); else warnings.push(text); } } });
  const call = (params: Record<string, unknown>) => tool!.execute('id', params, undefined, undefined, {});
  /** Runs the scheduled poll and waits for it to settle. */
  const fire = async () => { const fn = timers.shift(); assert.ok(fn, 'a poll is scheduled'); await fn(); };
  return { gh, sent, timers, call, fire, handlers, dir, warnings, events, shown };
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

test('a session restart during a poll leaves exactly one poll loop', async () => {
  let accept!: () => void, entered!: () => void;
  const pending = new Promise<void>(r => { accept = r; });
  const started = new Promise<void>(r => { entered = r; });
  const h = harness('tui', tempDir(), () => { entered(); return pending; });
  h.gh.set(pr(1, {}, [['test', 'IN_PROGRESS']]));
  await h.call({ action: 'watch', repo: 'o/r', prs: [1] });
  h.gh.set(pr(1, { mergeStateStatus: 'CLEAN' }));
  const fired = h.fire();
  await started;
  h.handlers.get('session_shutdown')!({}, { mode: 'tui' });
  h.handlers.get('session_start')!({}, { mode: 'tui', hasUI: true, ui: { notify: () => {} } });
  assert.equal(h.timers.length, 1, 'the restart schedules its own first poll');
  accept(); await fired;
  assert.equal(h.timers.length, 1, 'the poll that began before the restart does not schedule a second loop');
});

test('a watch made from a subagent or one-shot session does not start a poll loop there', async () => {
  const child = harness('json');
  child.gh.set(pr(1, {}, [['test', 'IN_PROGRESS']]));
  await child.call({ action: 'watch', repo: 'o/r', prs: [1] });
  assert.equal(child.timers.length, 0);
  assert.deepEqual(Object.keys(new Store(child.dir).load().repos), ['o/r'], 'the watch is still recorded for the interactive poller');
  const bash = { toolName: 'bash', input: { command: 'git commit -m x && git ' + 'push origin main' }, content: [], isError: false };
  assert.equal(await child.handlers.get('tool_result')!(bash, { mode: 'json', cwd: '/w' }), undefined);
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

test('a PR another process asks to follow (ship.mjs, a background shell) is followed and its merge wakes the agent', async () => {
  const h = harness();
  h.gh.set(pr(32, { autoMergeRequest: {} }, [['test', 'IN_PROGRESS']]));
  requestFollow(h.dir, { repo: 'o/r', pr: 32 });
  await h.fire();
  assert.equal(h.sent.length, 0, 'following is a baseline: nothing to announce yet');
  assert.deepEqual(pendingFollows(h.dir), [], 'the request is consumed');
  h.gh.set(pr(32, { state: 'MERGED', autoMergeRequest: {}, mergeCommit: { oid: 'cf5d0032aaaa' } }));
  await h.fire();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /#32 merged cf5d0032/);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: 'steer' });
});

/** A repository `o/r` whose main checkout the agent leaves clean, and a feature branch checked out in a linked worktree, as scripts/ship.mjs leaves them. */
function shipped() {
  const w = gitWorld();
  run(w.main, 'remote', 'set-url', 'origin', w.origin);
  const linked = join(w.main, '.worktrees', 'feat-x');
  run(w.main, 'worktree', 'add', '-q', '-b', 'feat/x', linked);
  const head = run(linked, 'rev-parse', 'HEAD');
  // GitHub's squash merge lands on origin/main; the PR head is the branch commit.
  w.merge();
  const git: GitRunner = (args, cwd) => args[0] === 'remote' && args[1] === 'get-url' && cwd === w.main ? Promise.resolve('https://github.com/o/r.git') : gitRunner(args, cwd);
  return { ...w, linked, head, git };
}
const merged = (n: number, head: string) => pr(n, { state: 'MERGED', autoMergeRequest: {}, headRefOid: head.padEnd(40, '0'), mergeCommit: { oid: 'cf5d0032aaaa' } });

test('a PR a script follows from a linked worktree is cleaned up, the main checkout fast-forwarded, and the merge is delivered without a turn', async () => {
  const s = shipped();
  const h = harness('tui', tempDir(), undefined, { git: s.git });
  h.gh.set(pr(33, { autoMergeRequest: {}, headRefOid: s.head.padEnd(40, '0') }, [['test', 'IN_PROGRESS']]));
  requestFollow(h.dir, { repo: 'o/r', pr: 33, clone: s.linked });
  await h.fire();
  h.gh.set(merged(33, s.head));
  await h.fire();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, QUIET);
  assert.match(h.sent[0].message.content, /#33 merged cf5d0032/);
  assert.match(h.sent[0].message.content, /removed worktree .*feat-x and branch feat\/x/);
  assert.match(h.sent[0].message.content, /fast-forwarded main in /);
  assert.equal(existsSync(s.linked), false);
  assert.equal(run(s.main, 'rev-parse', 'HEAD'), run(s.other, 'rev-parse', 'HEAD'));
});

test('the same merge wakes the agent when the main checkout is dirty, naming why it was not updated', async () => {
  const s = shipped();
  writeFileSync(join(s.main, 'a.txt'), 'wip');
  const h = harness('tui', tempDir(), undefined, { git: s.git });
  h.gh.set(pr(34, { autoMergeRequest: {}, headRefOid: s.head.padEnd(40, '0') }, [['test', 'IN_PROGRESS']]));
  requestFollow(h.dir, { repo: 'o/r', pr: 34, clone: s.linked });
  await h.fire();
  h.gh.set(merged(34, s.head));
  await h.fire();
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: 'steer' });
  assert.match(h.sent[0].message.content, /skipped fast-forward of .*: it has uncommitted changes/);
  assert.equal(readFileSync(join(s.main, 'a.txt'), 'utf8'), 'wip');
});

test('a script that names no clone: the loaded Pi package of that repository is the checkout (root cause of #270-#274 never being cleaned), and its merge wakes the agent, since it is not live until Pi reloads', async () => {
  const s = shipped();
  const h = harness('tui', tempDir(), undefined, { git: s.git, packages: [s.main] });
  h.gh.set(pr(35, { autoMergeRequest: {}, headRefOid: s.head.padEnd(40, '0') }, [['test', 'IN_PROGRESS']]));
  requestFollow(h.dir, { repo: 'o/r', pr: 35 });
  await h.fire();
  h.gh.set(merged(35, s.head));
  await h.fire();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: 'steer' }, 'a loaded package is not live until the agent reloads Pi');
  assert.match(h.sent[0].message.content, /fast-forwarded main in /);
  assert.match(h.sent[0].message.content, /reload needed: .* is a loaded Pi package/);
  assert.equal(run(s.main, 'rev-parse', 'HEAD'), run(s.other, 'rev-parse', 'HEAD'));
});

test('the same merge wakes when the main checkout sits on another branch with its own work: no fast-forward, a reload note', async () => {
  const s = shipped();
  run(s.main, 'checkout', '-q', '-b', 'feat/y');
  writeFileSync(join(s.main, 'y.txt'), 'other work'); run(s.main, 'add', '.'); run(s.main, 'commit', '-qm', 'y');
  const h = harness('tui', tempDir(), undefined, { git: s.git, packages: [s.main] });
  h.gh.set(pr(37, { autoMergeRequest: {}, headRefOid: s.head.padEnd(40, '0') }, [['test', 'IN_PROGRESS']]));
  requestFollow(h.dir, { repo: 'o/r', pr: 37, clone: s.linked });
  await h.fire();
  h.gh.set(merged(37, s.head));
  await h.fire();
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: 'steer' });
  assert.match(h.sent[0].message.content, /skipped fast-forward of .*: it is on feat\/y, not main/);
  assert.match(h.sent[0].message.content, /reload needed: /);
  assert.equal(run(s.main, 'branch', '--show-current'), 'feat/y');
});

test('a script that names no clone for a repository that is not a loaded package: no cleanup is possible, so the merge wakes', async () => {
  const h = harness('tui', tempDir(), undefined, { packages: [tempDir()] });
  h.gh.set(pr(36, { autoMergeRequest: {} }, [['test', 'IN_PROGRESS']]));
  requestFollow(h.dir, { repo: 'o/r', pr: 36 });
  await h.fire();
  h.gh.set(merged(36, 'abcdef12'));
  await h.fire();
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: 'steer' });
});

test('a malformed follow request is dropped without blocking the poll', async () => {
  const h = harness();
  requestFollow(h.dir, { repo: 'not a repo', pr: 1 });
  await h.fire();
  assert.deepEqual(pendingFollows(h.dir), []);
  assert.equal(h.sent.length, 0);
});

test('a merge queued with auto-merge wakes the agent on its own, without waiting for an operator message', async () => {
  const h = harness();
  h.gh.set(pr(31, { autoMergeRequest: {} }, [['test', 'IN_PROGRESS']]));
  await h.call({ action: 'watch', repo: 'o/r', prs: [31] });
  h.gh.set(pr(31, { state: 'MERGED', autoMergeRequest: {}, mergeCommit: { oid: 'cf5d0007aaaa' } }));
  await h.fire();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /#31 merged cf5d0007/);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: 'steer' }, 'the next step waits on the merge: it starts a turn');
  const status = await h.call({ action: 'status' });
  assert.match(status.content[0].text, /No repositories watched/);
  assert.match(status.content[0].text, /Host accepted: 1 wake requests, 0 next-turn notices; 0 uncertain/);
});

test('a subscriber takes its PR\'s notice from the event bus; the notices it does not take stay with this session', async () => {
  const h = harness();
  const taken: SubscriberNotice[] = [];
  h.events.on(SUBSCRIBER_NOTICE_CHANNEL, data => {
    const notice = data as SubscriberNotice;
    if (notice.subscriber !== 'worker-1') return;
    taken.push(notice);
    notice.accept();
  });
  h.gh.set(pr(90, {}, [['test', 'IN_PROGRESS']]), pr(91, {}, [['test', 'IN_PROGRESS']]));
  assert.equal((await h.call({ action: 'watch', repo: 'o/r', prs: [90], subscriber: 'worker-1' })).isError, undefined);
  await h.call({ action: 'watch', repo: 'o/r', prs: [91] });
  h.gh.set(pr(90, {}, [['test', 'COMPLETED', 'FAILURE']]), pr(91, {}, [['test', 'COMPLETED', 'FAILURE']]));
  await h.fire();
  assert.equal(taken.length, 1);
  assert.match(taken[0].text, /#90 checks failed/);
  assert.deepEqual(taken[0].events.map(e => e.pr), [90]);
  assert.equal(h.sent.length, 1, 'only the notice of #91 reaches this session');
  assert.match(h.sent[0].message.content, /#91 checks failed/);
  assert.doesNotMatch(h.sent[0].message.content, /#90/);
  assert.match((await h.call({ action: 'status', repo: 'o/r' })).content[0].text, /Subscribers \(all repos\): 1 notices taken by a subscriber, 0 handed back here/);
});

test('a notice no subscriber accepts comes back to this session, marked; a subscriber that throws does not lose it', async () => {
  const h = harness();
  h.gh.set(pr(92, {}, [['test', 'IN_PROGRESS']]));
  await h.call({ action: 'watch', repo: 'o/r', prs: [92], subscriber: 'worker-1' });
  h.gh.set(pr(92, {}, [['test', 'COMPLETED', 'FAILURE']]));
  await h.fire();
  assert.equal(h.sent.length, 1, 'no bus listener: the notice is handed back');
  assert.match(h.sent[0].message.content, /#92 checks failed[\s\S]*\(For worker-1: no subscriber accepted it, so it is delivered here\.\)/);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: 'steer' }, 'a failure still wakes the session');
  assert.match((await h.call({ action: 'status', repo: 'o/r' })).content[0].text, /1 handed back here because none accepted/);

  h.events.on(SUBSCRIBER_NOTICE_CHANNEL, () => { throw new Error('consumer crashed'); });
  h.gh.set(pr(92, {}, [['test', 'IN_PROGRESS']]));
  await h.fire();
  h.gh.set(pr(92, {}, [['test', 'COMPLETED', 'FAILURE']]));
  await h.fire();
  assert.equal(h.sent.length, 2, 'the throwing consumer does not drop the failure');
  assert.match(h.warnings.join('\n'), /subscriber worker-1 failed while taking a notice \(consumer crashed\)/);
});

test('a subscriber label is checked before any GitHub call', async () => {
  const h = harness();
  for (const [params, pattern] of [
    [{ action: 'watch', repo: 'o/r', prs: [1], subscriber: 'bad label!' }, /subscriber must be up to 64/],
    [{ action: 'watch', repo: 'o/r', subscriber: 'worker-1' }, /subscriber goes with watch and prs or branch/],
    [{ action: 'status', repo: 'o/r', subscriber: 'worker-1' }, /subscriber goes with watch/],
  ] as const) {
    const r = await h.call(params);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, pattern);
  }
  assert.equal(h.gh.calls.length, 0);
});

test('a child session merging a PR does not mark it as its own: the polling session still hears about the merge', async () => {
  const parent = harness();
  const child = harness('json', parent.dir);
  parent.gh.set(pr(102, { mergeStateStatus: 'CLEAN' }));
  await parent.call({ action: 'watch', repo: 'o/r', prs: [102] });
  await child.handlers.get('tool_result')!({ toolName: 'bash', isError: false, input: { command: 'gh pr merge 102 --repo o/r --squash' }, content: [] }, { mode: 'json', cwd: child.dir });
  parent.gh.set(pr(102, { state: 'MERGED', mergeCommit: { oid: 'cccc00112233' } }));
  await parent.fire();
  assert.equal(parent.sent.length, 1, 'the merge is not the parent\'s own: it wakes');
  assert.match(parent.sent[0].message.content, /#102 merged cccc0011/);
});

test('a merge this session makes with gh pr merge is recorded from bash: its own notice does not wake the agent', async () => {
  const h = harness();
  h.gh.set(pr(100, { mergeStateStatus: 'CLEAN' }), pr(101, { mergeStateStatus: 'CLEAN' }));
  await h.call({ action: 'watch', repo: 'o/r', prs: [100, 101] });
  await h.handlers.get('tool_result')!({ toolName: 'bash', isError: false, input: { command: 'gh pr merge 100 --repo o/r --squash' }, content: [] }, { mode: 'tui', cwd: h.dir });
  h.gh.set(pr(100, { state: 'MERGED', mergeCommit: { oid: 'aaaa00112233' } }), pr(101, { state: 'MERGED', mergeCommit: { oid: 'bbbb00112233' } }));
  await h.fire();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message.content, /#101 merged bbbb0011/);
  assert.doesNotMatch(h.sent[0].message.content, /#100/);
});

/** Every payload a channel carried, in order. */
const listen = <T>(h: { events: { on: (channel: string, fn: (data: unknown) => void) => unknown } }, channel: string) => {
  const seen: T[] = [];
  h.events.on(channel, data => seen.push(data as T));
  return seen;
};

test('a quiet notice is in the session as soon as it happens, visible, with no turn and no held copy', async () => {
  const s = shipped();
  const h = harness('tui', tempDir(), undefined, { git: s.git });
  h.gh.set(pr(37, { autoMergeRequest: {}, headRefOid: s.head.padEnd(40, '0') }, [['test', 'IN_PROGRESS']]));
  requestFollow(h.dir, { repo: 'o/r', pr: 37, clone: s.linked });
  await h.fire();
  assert.equal(h.sent.length, 0, 'a poll with nothing to report sends nothing');
  h.gh.set(merged(37, s.head));
  await h.fire();
  assert.equal(h.sent.length, 1, 'one message: the same one the operator sees and the model reads');
  assert.deepEqual(h.sent[0].options, QUIET, 'Pi holds a nextTurn message until the operator writes again; this one is appended now');
  assert.equal(h.sent[0].message.display, true);
  assert.match(h.sent[0].message.content, /^\[gitwatch\] o\/r · \d\d:\d\d\n  since last notice: #37 merged cf5d0032/);
  assert.equal(h.shown.length, 0, 'ctx.ui.notify is not used: Pi overwrites consecutive info lines, so only the last of several would stay');
});

test('several quiet notices over time are each a visible message of their own, none held for the next one', async () => {
  const s = shipped();
  const h = harness('tui', tempDir(), undefined, { git: s.git });
  for (const n of [60, 61, 62]) {
    h.gh.set(pr(n, { autoMergeRequest: {}, headRefOid: s.head.padEnd(40, '0') }, [['test', 'IN_PROGRESS']]));
    requestFollow(h.dir, { repo: 'o/r', pr: n, clone: s.main });
    await h.fire();
    h.gh.set(merged(n, s.head));
    await h.fire();
  }
  assert.deepEqual(h.sent.map(m => /#(6\d) merged/.exec(m.message.content)?.[1]), ['60', '61', '62']);
  for (const m of h.sent) {
    assert.deepEqual(m.options, QUIET);
    assert.equal(m.message.display, true);
  }
  assert.equal(h.shown.length, 0);
});

test('a wake notice is not duplicated on the UI: its steer message already shows', async () => {
  const h = harness();
  h.gh.set(pr(750, {}, [['test', 'IN_PROGRESS']]));
  await h.call({ action: 'watch', repo: 'o/r', prs: [750] });
  h.gh.set(pr(750, { mergeStateStatus: 'CLEAN' }));
  await h.fire();
  assert.deepEqual(h.sent[0].options, { triggerTurn: true, deliverAs: 'steer' });
  assert.equal(h.shown.length, 0);
});

test('every poll publishes gitwatch:state:v1: a pending, a failing and a clean PR, and a branch, with the data already fetched', async () => {
  const h = harness();
  const states = listen<Record<string, unknown>>(h, 'gitwatch:state:v1');
  const started = '2025-11-11T12:00:00Z', later = '2025-11-11T12:05:00Z';
  h.gh.set(
    pr(1, { title: 'pending one', headRefOid: 'abcdef0123'.padEnd(40, '0') }, [['build', 'IN_PROGRESS', null, later], ['lint', 'IN_PROGRESS', null, started], ['unit', 'COMPLETED', 'SUCCESS']]),
    pr(2, { title: 'failing one', url: 'https://github.com/o/r/pull/2', mergeStateStatus: 'UNSTABLE' }, [['test', 'COMPLETED', 'FAILURE']]),
    pr(3, { title: 'clean one', mergeStateStatus: 'CLEAN', autoMergeRequest: { enabledAt: 'x' } }, [['test', 'COMPLETED', 'SUCCESS']]),
  );
  h.gh.branches.set('main', commit('9999999abc', [['ci', 'IN_PROGRESS', null, started]]));
  await h.call({ action: 'watch', repo: 'o/r' });
  await h.call({ action: 'watch', repo: 'o/r', branch: 'main' });
  states.length = 0;
  const callsBefore = h.gh.calls.length;
  await h.fire();
  assert.equal(h.gh.calls.length - callsBefore, 1, 'publishing adds no GitHub call');
  assert.equal(states.length, 1);
  const [state] = states;
  assert.equal(state.version, 1);
  assert.equal(typeof state.polledAt, 'number');
  assert.deepEqual(state.repos, [{
    repo: 'o/r', mode: 'open',
    prs: [
      { repo: 'o/r', number: 1, title: 'pending one', url: 'https://github.com/o/r/pull/1', head: 'abcdef0', mergeState: 'BLOCKED', autoMerge: false, checks: { pass: 1, fail: 0, pending: 2 }, pendingSince: Date.parse(started), next: null },
      { repo: 'o/r', number: 2, title: 'failing one', url: 'https://github.com/o/r/pull/2', head: '2aaaaaa', mergeState: 'UNSTABLE', autoMerge: false, checks: { pass: 0, fail: 1, pending: 0 }, pendingSince: null, next: 'read the failing job log: gh pr checks 2 --repo o/r' },
      { repo: 'o/r', number: 3, title: 'clean one', url: 'https://github.com/o/r/pull/3', head: '3aaaaaa', mergeState: 'CLEAN', autoMerge: true, checks: { pass: 1, fail: 0, pending: 0 }, pendingSince: null, next: null },
    ],
    branches: [{ repo: 'o/r', branch: 'main', head: '9999999', checks: { pass: 0, fail: 0, pending: 1 }, pendingSince: Date.parse(started) }],
  }]);
});

test('gitwatch:notice:v1 carries each delivered notice; a state request re-emits the last state for a late consumer', async () => {
  const h = harness();
  const notices = listen<Record<string, unknown>>(h, 'gitwatch:notice:v1');
  const states = listen<Record<string, unknown>>(h, 'gitwatch:state:v1');
  h.gh.set(pr(750, {}, [['test', 'IN_PROGRESS']]));
  await h.call({ action: 'watch', repo: 'o/r', prs: [750] });
  h.events.emit('gitwatch:state:request:v1', {});
  assert.equal(states.length, 0, 'nothing was polled yet: nothing to re-emit');
  h.gh.set(pr(750, { mergeStateStatus: 'CLEAN' }));
  await h.fire();
  assert.equal(notices.length, 1);
  assert.equal(notices[0].repo, 'o/r');
  assert.equal(notices[0].wake, true);
  assert.match(String(notices[0].text), /#750 checks passed/);
  assert.equal(typeof notices[0].at, 'number');
  assert.deepEqual(notices[0].events, [{ pr: 750, kind: 'checks', text: 'checks passed 1/1', wake: true }, { pr: 750, kind: 'mergeState', text: 'mergeable (CLEAN)', wake: true }]);
  assert.equal(states.length, 1);
  const last = states[0];
  const calls = h.gh.calls.length;
  h.events.emit('gitwatch:state:request:v1', {});
  assert.equal(states.length, 2, 'the request re-emits');
  assert.deepEqual(states[1], last);
  assert.equal(h.gh.calls.length, calls, 're-emitting asks GitHub nothing');
});

test('the request listener leaves with the session: a restarted extension answers once', async () => {
  const h = harness();
  const states = listen<unknown>(h, 'gitwatch:state:v1');
  h.gh.set(pr(1, {}, [['test', 'IN_PROGRESS']]));
  await h.call({ action: 'watch', repo: 'o/r', prs: [1] });
  await h.fire();
  states.length = 0;
  h.handlers.get('session_shutdown')!({}, { mode: 'tui' });
  h.events.emit('gitwatch:state:request:v1', {});
  assert.equal(states.length, 0);
});

test('a session without a UI gets the same quiet message as one with a UI', async () => {
  const s = shipped();
  const h = harness('tui', tempDir(), undefined, { git: s.git });
  h.handlers.get('session_start')!({}, { mode: 'tui', hasUI: false });
  h.gh.set(pr(38, { autoMergeRequest: {}, headRefOid: s.head.padEnd(40, '0') }, [['test', 'IN_PROGRESS']]));
  requestFollow(h.dir, { repo: 'o/r', pr: 38, clone: s.linked });
  await h.fire();
  h.gh.set(merged(38, s.head));
  await h.fire();
  assert.deepEqual(h.sent[0].options, QUIET);
  assert.equal(h.sent[0].message.display, true);
  assert.equal(h.shown.length, 0);
});
