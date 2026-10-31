import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createdPrs, githubRepo, nativePath, pushes, resolvePush } from '../src/autowatch.ts';

test('only gh pr create output yields PRs to follow', () => {
  const out = 'Creating pull request\nhttps://github.com/lennix1337/pi-optchat/pull/28\n';
  assert.deepEqual(createdPrs('git push -u origin feat && gh pr create --fill', out), [{ repo: 'lennix1337/pi-optchat', pr: 28 }]);
  assert.deepEqual(createdPrs('gh pr view 28', out), [], 'a URL printed by another command is not followed');
});

test('git push is found with its directory, remote and branch', () => {
  assert.deepEqual(pushes('cd C:/projetos/dotfiles && git add -A && git commit -q -m "x" && git push -q origin main 2>&1 | tail -1', 'C:/Users/me'),
    [{ dir: 'C:/projetos/dotfiles', remote: 'origin', branch: 'main' }]);
  assert.deepEqual(pushes('git -C ../repo push -u origin HEAD:refs/heads/feat/y', '/work/a'), [{ dir: resolve('/work/a', '../repo'), remote: 'origin', branch: 'feat/y' }]);
  assert.deepEqual(pushes('git push', '/w'), [{ dir: '/w', remote: 'origin' }], 'no refspec: the current branch is resolved later');
  assert.deepEqual(pushes('git push -o ci.skip origin +fix', '/w'), [{ dir: '/w', remote: 'origin', branch: 'fix' }]);
});

// Seen live 2026-10-30: every `cd /c/projetos/<repo> && git push` from Git Bash ended in "could not start following push
// in /c/projetos/<repo>: spawn git ENOENT", because Node on Windows took /c/projetos for a folder on the current drive.
test('a Git Bash drive path names the Windows folder git runs in', () => {
  assert.equal(nativePath('/c/projetos/pi-optchat', 'win32'), 'C:/projetos/pi-optchat');
  assert.equal(nativePath('/d', 'win32'), 'D:/');
  assert.equal(nativePath('/c/projetos', 'linux'), '/c/projetos', 'elsewhere /c is an ordinary folder');
  assert.equal(nativePath('/work/a', 'win32'), '/work/a', 'only a one-letter first segment is a drive');
  if (process.platform === 'win32') assert.deepEqual(pushes('cd /c/projetos/pi-optchat && git push -u origin feat', 'C:/Users/me'),
    [{ dir: 'C:/projetos/pi-optchat', remote: 'origin', branch: 'feat' }]);
});

test('tags, deletions, dry runs and non-push git commands are ignored', () => {
  for (const command of ['git push --tags', 'git push origin --delete old', 'git push origin :old', 'git push -n origin main',
    'git push origin refs/tags/v1', 'git log --oneline | grep push', 'echo git push']) assert.deepEqual(pushes(command, '/w'), [], command);
});

test('a push resolves to a GitHub repository and branch through git', async () => {
  const calls: string[][] = [];
  const git = async (args: string[]) => { calls.push(args); return args[0] === 'remote' ? 'git@github.com:lennix1337/dotfiles.git' : args[1] === '--show-toplevel' ? 'C:/w' : 'main'; };
  assert.deepEqual(await resolvePush({ dir: '/w', remote: 'origin' }, git), { repo: 'lennix1337/dotfiles', branch: 'main', clone: 'C:/w' });
  assert.deepEqual(calls, [['remote', 'get-url', 'origin'], ['rev-parse', '--abbrev-ref', 'HEAD'], ['rev-parse', '--show-toplevel']]);
  const other = async () => 'https://gitlab.com/a/b.git';
  assert.equal(await resolvePush({ dir: '/w', remote: 'origin', branch: 'main' }, other), undefined, 'another host is not followed');
  assert.equal(githubRepo('https://github.com/o/r.git'), 'o/r');
  assert.equal(githubRepo('https://github.com/o/r'), 'o/r');
});
