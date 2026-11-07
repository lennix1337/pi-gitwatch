import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
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

test('the cleanup lines name the PR and are empty without a clone or merged event', async () => {
  const { dir, head } = repo();
  assert.deepEqual(await cleanupLines(gitRunner, { events: [{ kind: 'merged', pr: 3, head }] }), []);
  assert.deepEqual(await cleanupLines(gitRunner, { clone: dir, events: [{ kind: 'checks', pr: 3, head }] }), []);
  // Snapshots keep an 8-character head: git resolves the abbreviation.
  const lines = await cleanupLines(gitRunner, { clone: dir, events: [{ kind: 'merged', pr: 3, head: head.slice(0, 8) }] });
  assert.deepEqual(lines.map(l => l.pr), [3, 3, 3]);
  assert.match(lines[0].text, /^removed branch done$/);
  assert.match(lines[1].text, /^kept wt-dirty: .*untracked files/);
  assert.match(lines[2].text, /^removed worktree .* and branch wt-done$/);
});

test('a clone the agent already removed leaves no "spawn git ENOENT" note', async () => {
  const { dir, head } = repo();
  const gone = join(dir, 'worktrees', 'already-removed');
  assert.deepEqual(await cleanupLines(gitRunner, { clone: gone, events: [{ kind: 'merged', pr: 4, head }] }), []);
});

test('a merged head this clone never fetched (a contributor PR) leaves no "malformed object name" note', async () => {
  const { dir } = repo();
  assert.deepEqual(await cleanupLines(gitRunner, { clone: dir, events: [{ kind: 'merged', pr: 935, head: 'b2fff97d' }] }), []);
});
