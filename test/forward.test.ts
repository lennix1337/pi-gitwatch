import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { gitRunner } from '../src/autowatch.ts';
import { cleanupLines, fastForwardMain } from '../src/cleanup.ts';
import { normalizePath } from '../src/packages.ts';
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
  // Git prints the folder in its own spelling (long name, resolved link): compare the folder, not the string.
  assert.equal(normalizePath(/^fast-forwarded main in (.*) to [0-9a-f]+ /.exec(forwarded.text)![1]), normalizePath(w.main));
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

test('a package named by another spelling of the checkout git reports (8.3 short name, junction) is still that checkout', async () => {
  const w = world();
  w.merge();
  // The same folder through a second path, as the settings file or a short temp dir would spell it; git reports the real one.
  const alias = join(w.root, 'ALIAS');
  symlinkSync(w.root, alias, 'junction');
  const lines = await cleanupLines(gitRunner, { clone: join(alias, 'main'), events: [merged()] }, { packages: [join(alias, 'main')] });
  assert.ok(lines.some(l => l.text.startsWith('fast-forwarded main in')), lines.map(l => l.text).join(', '));
  assert.ok(lines.some(l => l.text.startsWith('reload needed')), lines.map(l => l.text).join(', '));
});

/** The main checkout on `feat/x` holding one commit (a new file) that the "other" clone lands on origin/main as a squash merge: same patch, new commit. */
function featureOnMain(world_ = world()) {
  const w = world_;
  run(w.main, 'checkout', '-q', '-b', 'feat/x');
  writeFileSync(join(w.main, 'feat.txt'), 'feature'); run(w.main, 'add', '.'); run(w.main, 'commit', '-qm', 'feature');
  const tip = run(w.main, 'rev-parse', 'HEAD');
  writeFileSync(join(w.other, 'feat.txt'), 'feature'); run(w.other, 'add', '.'); run(w.other, 'commit', '-qm', 'feature (squash)'); run(w.other, 'push', '-q', 'origin', 'main');
  return { ...w, tip };
}
const branches = (dir: string) => run(dir, 'branch', '--format=%(refname:short)').split('\n').sort();

test('a main checkout left on a feature branch whose commits all reached origin/main is moved to main, fast-forwarded, and the branch removed', async () => {
  const w = featureOnMain();
  const lines = await cleanupLines(gitRunner, { clone: w.main, events: [merged(7, 'deadbeef')] });
  const text = lines.map(l => l.text).join('\n');
  assert.ok(lines.every(l => !l.left), text);
  assert.match(text, /switched .* from feat\/x to main: its commits are in origin\/main/);
  assert.match(text, /removed branch feat\/x/);
  assert.match(text, /fast-forwarded main in /);
  assert.equal(run(w.main, 'branch', '--show-current'), 'main');
  assert.deepEqual(branches(w.main), ['main']);
  assert.equal(run(w.main, 'rev-parse', 'HEAD'), run(w.other, 'rev-parse', 'HEAD'));
});

test('a feature branch that is exactly the merged PR head is moved off even when the merge kept its commits as they were', async () => {
  const w = world();
  run(w.main, 'checkout', '-q', '-b', 'feat/x');
  writeFileSync(join(w.main, 'feat.txt'), 'feature'); run(w.main, 'add', '.'); run(w.main, 'commit', '-qm', 'feature');
  const tip = run(w.main, 'rev-parse', 'HEAD');
  run(w.main, 'push', '-q', 'origin', 'feat/x:main');
  const lines = await cleanupLines(gitRunner, { clone: w.main, events: [merged(7, tip.slice(0, 8))] });
  assert.ok(lines.every(l => !l.left), lines.map(l => l.text).join('\n'));
  assert.equal(run(w.main, 'branch', '--show-current'), 'main');
  assert.deepEqual(branches(w.main), ['main']);
});

test('a feature branch with a commit origin/main does not have is never left: it stays checked out and the skip is only reported', async () => {
  const w = featureOnMain();
  writeFileSync(join(w.main, 'later.txt'), 'not merged'); run(w.main, 'add', '.'); run(w.main, 'commit', '-qm', 'later work');
  const before = run(w.main, 'rev-parse', 'HEAD');
  const lines = await cleanupLines(gitRunner, { clone: w.main, events: [merged(7, 'deadbeef')] });
  assert.equal(run(w.main, 'branch', '--show-current'), 'feat/x');
  assert.equal(run(w.main, 'rev-parse', 'HEAD'), before);
  assert.match(lines.map(l => l.text).join('\n'), /skipped fast-forward of .*: it is on feat\/x, not main/);
  assert.ok(lines.every(l => !l.left), 'being on another branch is not something the agent has to fix');
});

test('a merged feature branch with uncommitted changes to tracked files is never switched', async () => {
  const w = featureOnMain();
  writeFileSync(join(w.main, 'feat.txt'), 'my work in progress');
  const lines = await cleanupLines(gitRunner, { clone: w.main, events: [merged(7, 'deadbeef')] });
  assert.equal(run(w.main, 'branch', '--show-current'), 'feat/x');
  assert.equal(readFileSync(join(w.main, 'feat.txt'), 'utf8'), 'my work in progress');
  assert.ok(branches(w.main).includes('feat/x'));
  assert.ok(!lines.some(l => l.text.startsWith('switched')), lines.map(l => l.text).join('\n'));
});

test('a branch that was just created and holds no commit of its own is not mistaken for a merged one', async () => {
  const w = world();
  w.merge();
  run(w.main, 'checkout', '-q', '-b', 'fresh');
  await cleanupLines(gitRunner, { clone: w.main, events: [merged(7, 'deadbeef')] });
  assert.equal(run(w.main, 'branch', '--show-current'), 'fresh');
});
