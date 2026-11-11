import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { gitRunner } from '../src/autowatch.ts';
import { cleanupLines, fastForwardMain } from '../src/cleanup.ts';
import { gitWorld as world, run } from './fixtures.ts';

/** The folder spelled differently from what git prints: upper case where the filesystem ignores case (Windows), a trailing slash everywhere. */
const spelled = (p: string) => `${process.platform === 'win32' ? p.toUpperCase() : p}/`;
const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase();

const merged = (pr = 7, head = 'deadbeef') => ({ kind: 'merged', pr, head });

test('a clean main checkout on the default branch is fast-forwarded to the merge and nothing is left', async () => {
  const w = world();
  w.merge();
  const before = run(w.main, 'rev-parse', 'HEAD');
  const lines = await cleanupLines(gitRunner, { clone: w.main, events: [merged()] });
  assert.equal(lines.length, 1, lines.map(l => l.text).join('\n'));
  assert.match(lines[0].text, /^fast-forwarded main in .* to [0-9a-f]{7,} \(1 commit\)$/);
  assert.equal(lines[0].left, undefined);
  assert.equal(lines[0].pr, 7);
  assert.notEqual(run(w.main, 'rev-parse', 'HEAD'), before);
  assert.equal(run(w.main, 'rev-parse', 'HEAD'), run(w.other, 'rev-parse', 'HEAD'));
  assert.equal(readFileSync(join(w.main, 'merged.txt'), 'utf8'), 'squash');
});

test('a main checkout already up to date says nothing', async () => {
  const w = world();
  assert.deepEqual(await cleanupLines(gitRunner, { clone: w.main, events: [merged()] }), []);
});

test('a push from a linked worktree updates the main checkout, not the worktree', async () => {
  const w = world();
  const linked = join(w.root, 'main', '.worktrees', 'feat-x');
  run(w.main, 'worktree', 'add', '-q', '-b', 'feat/x', linked);
  const featHead = run(linked, 'rev-parse', 'HEAD');
  w.merge();
  const lines = await cleanupLines(gitRunner, { clone: linked, events: [{ kind: 'merged', pr: 8, head: featHead }] });
  assert.ok(lines.some(l => l.text.startsWith('removed worktree') && l.text.endsWith('and branch feat/x')), lines.map(l => l.text).join('\n'));
  const forwarded = lines.find(l => l.text.startsWith('fast-forwarded main in'));
  assert.ok(forwarded, lines.map(l => l.text).join('\n'));
  assert.equal(norm(forwarded.text).includes(norm(w.main)), true);
  assert.equal(run(w.main, 'rev-parse', 'HEAD'), run(w.other, 'rev-parse', 'HEAD'));
  assert.ok(lines.every(l => !l.left), 'nothing is left once the branch, worktree and main checkout are handled');
});

test('a main checkout with uncommitted changes to tracked files is never touched and the reason is left', async () => {
  const w = world();
  w.merge();
  writeFileSync(join(w.main, 'a.txt'), 'my work in progress');
  const before = run(w.main, 'rev-parse', 'HEAD');
  const lines = await cleanupLines(gitRunner, { clone: w.main, events: [merged()] });
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^skipped fast-forward of .*: it has uncommitted changes$/);
  assert.equal(lines[0].left, true);
  assert.equal(run(w.main, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(w.main, 'a.txt'), 'utf8'), 'my work in progress');
  assert.equal(run(w.main, 'stash', 'list'), '', 'nothing is stashed');
});

test('an untracked file that does not collide does not stop the fast-forward', async () => {
  const w = world();
  w.merge();
  writeFileSync(join(w.main, 'scratch.txt'), 'notes');
  const lines = await cleanupLines(gitRunner, { clone: w.main, events: [merged()] });
  assert.match(lines[0].text, /^fast-forwarded main/);
  assert.equal(readFileSync(join(w.main, 'scratch.txt'), 'utf8'), 'notes');
});

test('an untracked file the merge would overwrite keeps the checkout as it is and the failure is left', async () => {
  const w = world();
  w.merge();
  writeFileSync(join(w.main, 'merged.txt'), 'mine');
  const before = run(w.main, 'rev-parse', 'HEAD');
  const lines = await cleanupLines(gitRunner, { clone: w.main, events: [merged()] });
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^skipped fast-forward of /);
  assert.equal(lines[0].left, true);
  assert.equal(run(w.main, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(w.main, 'merged.txt'), 'utf8'), 'mine');
});

test('a diverged main checkout is not merged or reset and the reason is left', async () => {
  const w = world();
  w.merge();
  writeFileSync(join(w.main, 'local.txt'), 'unpushed'); run(w.main, 'add', '.'); run(w.main, 'commit', '-qm', 'local only');
  const before = run(w.main, 'rev-parse', 'HEAD');
  const lines = await cleanupLines(gitRunner, { clone: w.main, events: [merged()] });
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^skipped fast-forward of .*: main diverged from origin\/main \(1 ahead, 1 behind\)$/);
  assert.equal(lines[0].left, true);
  assert.equal(run(w.main, 'rev-parse', 'HEAD'), before);
});

test('a main checkout on another branch or a detached HEAD is skipped with the reason', async () => {
  const w = world();
  w.merge();
  run(w.main, 'checkout', '-q', '-b', 'wip');
  assert.match((await fastForwardMain(gitRunner, w.main))!.text, /: it is on wip, not main$/);
  run(w.main, 'checkout', '-q', '--detach');
  assert.match((await fastForwardMain(gitRunner, w.main))!.text, /: HEAD is detached$/);
  assert.notEqual(run(w.main, 'rev-parse', 'main'), run(w.other, 'rev-parse', 'HEAD'), 'main did not move');
});

test('a loaded Pi package adds a `reload needed` line that is information, not left, compared by normalized path', async () => {
  const w = world();
  w.merge();
  const lines = await cleanupLines(gitRunner, { clone: w.main, events: [merged()] }, { packages: [spelled(w.main)] });
  const reload = lines.find(l => l.text.startsWith('reload needed'));
  assert.ok(reload, lines.map(l => l.text).join('\n'));
  assert.equal(reload.left, undefined, 'it asks nothing of the agent by itself');
  const unrelated = await cleanupLines(gitRunner, { clone: w.main, events: [merged()] }, { packages: [join(w.root, 'elsewhere')] });
  assert.ok(unrelated.every(l => !l.text.startsWith('reload needed')));
});
