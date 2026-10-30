import assert from 'node:assert/strict';
import { test } from 'node:test';
import extension, { Lease, MESSAGE_TYPE } from '../src/index.ts';
import { Store } from '../src/watcher.ts';
import { FakeGitHub, pr, tempDir } from './fixtures.ts';

type Handler = (event: unknown, ctx: { mode: string }) => unknown;
function harness(mode = 'tui', dir = tempDir()) {
  const gh = new FakeGitHub();
  const handlers = new Map<string, Handler>();
  const sent: { message: { customType: string; content: string }; options: unknown }[] = [];
  const timers: (() => void)[] = [];
  let tool: { execute: (...a: unknown[]) => Promise<{ content: { text: string }[]; isError?: boolean }> } | undefined;
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, h),
    registerTool: (t: typeof tool) => { tool = t; },
    sendMessage: (message: { customType: string; content: string }, options: unknown) => sent.push({ message, options }),
  };
  extension(pi as never, { run: gh.run, store: new Store(dir), schedule: fn => { timers.push(fn); return timers.length; }, cancel: () => {} });
  handlers.get('session_start')!({}, { mode });
  const call = (params: Record<string, unknown>) => tool!.execute('id', params, undefined, undefined, {});
  /** Runs the scheduled poll and waits for it to settle. */
  const fire = async () => { const fn = timers.shift(); assert.ok(fn, 'a poll is scheduled'); fn(); await new Promise(r => setTimeout(r, 20)); };
  return { gh, sent, timers, call, fire, handlers, dir };
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

test('status refreshes now and shows the change instead of announcing it later', async () => {
  const h = harness();
  h.gh.set(pr(1, {}, [['test', 'IN_PROGRESS']]));
  await h.call({ action: 'watch', repo: 'o/r' });
  h.gh.set(pr(1, {}, [['test', 'COMPLETED', 'FAILURE']]));
  const status = await h.call({});
  assert.match(status.content[0].text, /changed since last poll: #1 checks failed: test/);
  await h.fire();
  assert.equal(h.sent.length, 0);
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
