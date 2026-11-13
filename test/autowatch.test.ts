import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createdPrs, githubRepo, nativePath, ownMerges, pushes, resolvePush } from '../src/autowatch.ts';

test('only gh pr create output yields PRs to follow', () => {
  const out = 'Creating pull request\nhttps://github.com/lennix1337/pi-optchat/pull/28\n';
  assert.deepEqual(createdPrs('git push -u origin feat && gh pr create --fill', out), [{ repo: 'lennix1337/pi-optchat', pr: 28 }]);
  assert.deepEqual(createdPrs('gh pr view 28', out), [], 'a URL printed by another command is not followed');
});

test('git push is found with its directory, remote and branch', () => {
  assert.deepEqual(pushes('cd C:/projetos/dotfiles && git add -A && git commit -q -m "x" && git push -q origin main 2>&1 | tail -1', 'C:/Users/me'),
    [{ dir: 'C:/projetos/dotfiles', remote: 'origin', branch: 'main' }]);
  assert.deepEqual(pushes('git -C ../repo push -u origin HEAD:refs/heads/feat/y', '/work/a'), [{ dir: resolve('/work/a', '../repo'), remote: 'origin', branch: 'feat/y' }]);
  assert.deepEqual(pushes('git push', '/w'), [{ dir: '/w', remote: 'origin', implicitRemote: true }], 'no refspec: the current branch is resolved later');
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

// Seen live 2026-11-05: `cd ~/.optchat/profiles/x && ...` made git run in "C:\Users\me\~\.optchat\..." (spawn ENOENT), and a
// node -e script that merely contained "git push" inside a quoted regex was taken for a push.
test('cd ~ and $HOME name the home folder, not a folder called ~', () => {
  const homeDir = homedir().replaceAll('\\', '/');
  assert.deepEqual(pushes('cd ~/proj && git push origin main', '/w'), [{ dir: `${homeDir}/proj`, remote: 'origin', branch: 'main' }]);
  assert.deepEqual(pushes('cd "$HOME/proj" && git push origin main', '/w'), [{ dir: `${homeDir}/proj`, remote: 'origin', branch: 'main' }]);
  assert.deepEqual(pushes('cd ~ && git push origin main', '/w'), [{ dir: homeDir, remote: 'origin', branch: 'main' }]);
  assert.deepEqual(ownMerges('cd ~/proj && gh pr merge 5', '/w'), [{ pr: 5, dir: `${homeDir}/proj` }]);
});

test('a command inside quotes is text, not a command', () => {
  for (const command of [`node -e "const r=/git push|git pull/; console.log(r)"`, `grep -E 'a|git push' f`, `echo "x && git push origin main"`, `echo 'x; git push'`])
    assert.deepEqual(pushes(command, '/w'), [], command);
  assert.deepEqual(ownMerges(`echo "ok; gh pr merge 7"`, '/w'), []);
  assert.deepEqual(pushes(`git commit -m "a; b" && git push origin main`, '/w'), [{ dir: '/w', remote: 'origin', branch: 'main' }], 'a push after a quoted separator is still found');
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

test('the remote URL and the repository root of a push are read together, not one after the other', async () => {
  // Deterministic: each git call waits until the other has started. Sequential reads would time out.
  let started = 0;
  const barrier = async () => {
    started++;
    const deadline = Date.now() + 1000;
    while (started < 2) { if (Date.now() > deadline) throw new Error('git calls ran one after the other'); await new Promise(r => setTimeout(r, 1)); }
  };
  const git = async (args: string[]) => { await barrier(); return args[0] === 'remote' ? 'git@github.com:o/r.git' : 'C:/w'; };
  assert.deepEqual(await resolvePush({ dir: '/w', remote: 'origin', branch: 'main' }, git), { repo: 'o/r', branch: 'main', clone: 'C:/w' });
});

// Seen live 2026-11-01/02: a bare `git push` from a worktree whose branch tracks a fork (other remote, other branch name)
// ended in "Branch fix/x not found in lennix1337/Genexus18MCP", because the push was read as going to origin under the local name.
test('a bare push follows the remote and branch the push really goes to', async () => {
  const git = async (args: string[]) => args[0] === 'remote' ? (args[2] === 'fork' ? 'https://github.com/davidagostini/Genexus18MCP.git' : 'https://github.com/lennix1337/Genexus18MCP.git')
    : args.includes('@{push}') ? 'fork/fix/x-remote' : args[1] === '--show-toplevel' ? 'C:/w' : 'fix/x';
  assert.deepEqual(await resolvePush({ dir: '/w', remote: 'origin', implicitRemote: true }, git), { repo: 'davidagostini/Genexus18MCP', branch: 'fix/x-remote', clone: 'C:/w' });
  assert.deepEqual(await resolvePush({ dir: '/w', remote: 'origin' }, git), { repo: 'lennix1337/Genexus18MCP', branch: 'fix/x', clone: 'C:/w' }, 'an explicit remote is never replaced');
  const noUpstream = async (args: string[]) => { if (args.includes('@{push}')) throw new Error('no upstream'); return args[0] === 'remote' ? 'git@github.com:o/r.git' : 'main'; };
  assert.deepEqual(await resolvePush({ dir: '/w', remote: 'origin', implicitRemote: true }, noUpstream), { repo: 'o/r', branch: 'main', clone: 'main' }, 'without an upstream the current branch on origin is used');
});

test('a gh pr merge that merges now is an own merge; a queued one (--auto), a dry word and a failed-to-name PR are not', () => {
  assert.deepEqual(ownMerges('gh pr merge 12 --repo o/r --squash', '/x'), [{ pr: 12, repo: 'o/r', dir: '/x' }]);
  assert.deepEqual(ownMerges('gh pr merge https://github.com/o/r/pull/7 --squash', '/x'), [{ pr: 7, repo: 'o/r', dir: '/x' }], 'a PR URL names its repository');
  assert.deepEqual(ownMerges('gh pr merge 12 -R o/r -t "merge 9"', '/x'), [{ pr: 12, repo: 'o/r', dir: '/x' }], 'a value after -t is not a PR');
  assert.deepEqual(ownMerges('gh pr merge 12 --auto --repo o/r', '/x'), [], 'auto-merge only queues the merge');
  assert.deepEqual(ownMerges('echo gh pr merge 12', '/x'), [], 'a word inside another command is not a merge');
  assert.deepEqual(ownMerges('gh pr merge --squash', '/x'), [], 'no PR named: nothing is recorded');
  assert.deepEqual(ownMerges('gh pr merge 3 && gh pr merge 4 --auto', '/x'), [{ pr: 3, dir: '/x' }], 'each command of a chain is read');
  assert.deepEqual(ownMerges('cd sub && gh pr merge 5', '/x'), [{ pr: 5, dir: resolve('/x', 'sub') }], 'the merge runs where the cd leads');
});

// Seen live 2026-11-13: `git push origin v0.1.1` ended in "Branch v0.1.1 not found in lennix1337/pi-vault", a tag read as a branch.
test('a push of a tag name follows nothing; a branch of the same repository still does', async () => {
  const git = async (args: string[]) => {
    if (args[0] === 'rev-parse' && args[1] === '--verify') { if (args.at(-1) === 'refs/tags/v0.1.1') return 'abc'; throw new Error('unknown ref'); }
    return args[0] === 'remote' ? 'https://github.com/lennix1337/pi-vault.git' : args[1] === '--show-toplevel' ? 'C:/w' : 'main';
  };
  assert.equal(await resolvePush({ dir: '/w', remote: 'origin', branch: 'v0.1.1' }, git), undefined);
  assert.deepEqual(await resolvePush({ dir: '/w', remote: 'origin', branch: 'feat' }, git), { repo: 'lennix1337/pi-vault', branch: 'feat', clone: 'C:/w' });
});
