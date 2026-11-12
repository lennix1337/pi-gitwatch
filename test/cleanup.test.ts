import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitRunner } from '../src/autowatch.ts';
import { cleanMerged, cleanupLines } from '../src/cleanup.ts';
import { tempDir } from './fixtures.ts';

/** A real repository: `main`, a merged branch `done` (plain, and a clean worktree `wt-done`), a dirty worktree and later work. */
function repo() {
  const dir = tempDir();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.txt'), '1'); git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-q', '-b', 'done'); writeFileSync(join(dir, 'a.txt'), '2'); git('commit', '-qam', 'feature');
  const head = git('rev-parse', 'HEAD');
  git('branch', 'wt-done'); git('branch', 'wt-dirty'); git('branch', 'ahead');
  git('checkout', '-q', 'main');
  const clean = join(dir, 'worktrees', 'clean'), dirty = join(dir, 'worktrees', 'dirty');
  git('worktree', 'add', '-q', clean, 'wt-done');
  git('worktree', 'add', '-q', dirty, 'wt-dirty');
  writeFileSync(join(dirty, 'wip.txt'), 'uncommitted');
  // `ahead` gained a commit after the PR merged: it no longer points at the head, so it is not touched.
  git('checkout', '-q', 'ahead');
  writeFileSync(join(dir, 'b.txt'), 'later'); git('add', 'b.txt'); git('commit', '-qm', 'later'); git('checkout', '-q', 'main');
  return { dir, head, clean, dirty, git };
}

test('a merged head cleans its plain branch and clean worktree, and keeps dirty, checked-out and newer work', async () => {
  const { dir, head, clean, dirty, git } = repo();
  git('checkout', '-q', 'done');
  const lines = await cleanMerged(gitRunner, dir, head);
  const branches = git('branch', '--format=%(refname:short)').split('\n').sort();
  assert.deepEqual(branches, ['ahead', 'done', 'main', 'wt-dirty']);
  assert.equal(existsSync(clean), false);
  assert.equal(existsSync(join(dirty, 'wip.txt')), true);
  assert.ok(lines.some(l => l.startsWith('kept done: checked out in')), lines.join('\n'));
  assert.ok(lines.some(l => l.startsWith('removed worktree') && l.endsWith('and branch wt-done')), lines.join('\n'));
  assert.ok(lines.some(l => l.startsWith('kept wt-dirty:')), lines.join('\n'));
});

test('long-lived branches are never removed, even at the merged head', async () => {
  const { dir, head, git } = repo();
  git('branch', '-f', 'develop', head);
  await cleanMerged(gitRunner, dir, head);
  assert.match(git('branch', '--list', 'develop'), /develop/);
});

test('the cleanup lines name the PR and are empty without a clone or merged event; a failure that needs the agent is marked left', async () => {
  const { dir, head } = repo();
  assert.deepEqual(await cleanupLines(gitRunner, { events: [{ kind: 'merged', pr: 3, head }] }), []);
  assert.deepEqual(await cleanupLines(gitRunner, { clone: dir, events: [{ kind: 'checks', pr: 3, head }] }), []);
  // Snapshots keep an 8-character head: git resolves the abbreviation.
  const lines = await cleanupLines(gitRunner, { clone: dir, events: [{ kind: 'merged', pr: 3, head: head.slice(0, 8) }] });
  assert.deepEqual(lines.map(l => l.pr), [3, 3, 3, 3]);
  assert.match(lines[0].text, /^removed branch done$/);
  assert.equal(lines[0].left, undefined);
  assert.match(lines[1].text, /^kept wt-dirty: .*untracked files/);
  assert.equal(lines[1].left, undefined, 'a kept worktree with uncommitted files is only reported: the notice lists it, no turn is needed');
  assert.match(lines[2].text, /^removed worktree .* and branch wt-done$/);
  assert.match(lines[3].text, /^skipped fast-forward of .*: main has no upstream$/, 'this repository has no remote to update from');
});

test('a branch that cannot be deleted for another reason than a checkout or a dirty worktree is left for the agent', async () => {
  const { dir, head, git } = repo();
  git('checkout', '-q', 'main');
  const failing = (args: string[], cwd: string) => args[0] === 'branch' && args[1] === '-D' ? Promise.reject(new Error('Command failed: git branch\nerror: cannot lock ref')) : gitRunner(args, cwd);
  const lines = await cleanupLines(failing, { clone: dir, events: [{ kind: 'merged', pr: 3, head: head.slice(0, 8) }] });
  const kept = lines.find(l => l.text.startsWith('kept done:'));
  assert.ok(kept, lines.map(l => l.text).join(', '));
  assert.equal(kept.left, true);
});

test('a branch checked out in the main worktree is only reported: the notice lists it, no turn is needed', async () => {
  const { dir, head, git } = repo();
  git('checkout', '-q', 'done');
  const lines = await cleanupLines(gitRunner, { clone: dir, events: [{ kind: 'merged', pr: 3, head }] });
  const kept = lines.find(l => l.text.startsWith('kept done: checked out in'));
  assert.ok(kept, lines.map(l => l.text).join(', '));
  assert.equal(kept.left, undefined);
});

test('a clone the agent already removed is one clear left line, not a "spawn git ENOENT" note', async () => {
  const { dir, head } = repo();
  const gone = join(dir, 'worktrees', 'already-removed');
  const lines = await cleanupLines(gitRunner, { clone: gone, events: [{ kind: 'merged', pr: 4, head }] });
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /^cleanup skipped: .* no longer exists/);
  assert.equal(lines[0].left, true);
  assert.doesNotMatch(lines[0].text, /ENOENT/);
});

test('a merged head this clone never fetched (a contributor PR) leaves no "malformed object name" note', async () => {
  const { dir } = repo();
  const lines = await cleanupLines(gitRunner, { clone: dir, events: [{ kind: 'merged', pr: 935, head: 'b2fff97d' }] });
  assert.ok(lines.every(l => !/malformed|bad object|unknown revision/.test(l.text)), lines.map(l => l.text).join(', '));
  assert.ok(lines.every(l => !l.text.startsWith('kept') && !l.text.startsWith('removed')), 'nothing local to clean for a head never fetched');
});

test('a worktree folder deleted by hand is pruned and its merged branch removed', async () => {
  const { dir, head, clean, git } = repo();
  rmSync(clean, { recursive: true, force: true });
  assert.match(git('worktree', 'list', '--porcelain'), /prunable/);
  const calls: string[] = [];
  const spy: typeof gitRunner = (args, cwd) => { calls.push(args.slice(0, 3).join(' ')); return gitRunner(args, cwd); };
  const lines = await cleanMerged(spy, dir, head);
  assert.ok(calls.includes('worktree prune'), calls.join('\n'));
  assert.ok(!calls.some(c => c.startsWith('worktree remove') && c.includes('clean')), calls.join('\n'));
  assert.ok(lines.some(l => l.startsWith('removed worktree') && l.endsWith('and branch wt-done')), lines.join('\n'));
  assert.doesNotMatch(git('branch', '--format=%(refname:short)'), /wt-done/);
  assert.doesNotMatch(git('worktree', 'list', '--porcelain'), /worktrees[\/]clean/);
});

test('cleanup runs git from the main worktree even when the notice names a linked one', async () => {
  const { dir, head, dirty, clean, git } = repo();
  const cwds: string[] = [];
  const spy: typeof gitRunner = (args, cwd) => { cwds.push(`${args.slice(0, 2).join(' ')}@${cwd}`); return gitRunner(args, cwd); };
  await cleanMerged(spy, dirty, head);
  const norm = (p: string) => p.replaceAll('\\', '/').toLowerCase();
  const main = norm(git('rev-parse', '--show-toplevel'));
  const removes = cwds.filter(c => c.startsWith('worktree remove@') || c.startsWith('branch -D@'));
  assert.ok(removes.length >= 2, cwds.join('\n'));
  for (const c of removes) assert.equal(norm(c.slice(c.indexOf('@') + 1)), main, c);
  assert.equal(existsSync(clean), false);
  assert.equal(existsSync(join(dirty, 'wip.txt')), true);
});
