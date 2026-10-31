import { execFile } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { BRANCH } from './github.ts';

/** Runs `git` in `cwd` and resolves its trimmed stdout. Injected in tests. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

export const gitRunner: GitRunner = (args, cwd) => new Promise((done, fail) => {
  execFile('git', args, { cwd, timeout: 10_000, windowsHide: true }, (error, stdout) => error ? fail(error) : done(stdout.trim()));
});

/** A PR that `gh pr create` printed. */
export interface CreatedPr { repo: string; pr: number }
/** A `git push` found in a shell command: where it ran, to which remote, and the branch named, if any. */
export interface Push { dir: string; remote: string; branch?: string }

const GITHUB_URL = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** `owner/name` of a GitHub remote URL (https or ssh), or undefined for another host. */
export function githubRepo(url: string): string | undefined {
  const m = GITHUB_URL.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** PRs created by the command: only `gh pr create`, so URLs merely printed by other commands are never followed. */
export function createdPrs(command: string, output: string): CreatedPr[] {
  if (!/\bgh\s+pr\s+create\b/.test(command)) return [];
  const found = new Map<string, CreatedPr>();
  for (const m of output.matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g)) found.set(`${m[1]}#${m[2]}`, { repo: m[1], pr: Number(m[2]) });
  return [...found.values()];
}

/** Splits a shell token list, honouring simple single and double quotes. */
function tokens(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
}

/** Options that make a push carry no branch commit worth following. */
const NOT_A_BRANCH_PUSH = new Set(['--tags', '--delete', '-d', '--mirror', '--all', '--dry-run', '-n', '--prune']);
/** Options whose value is the next word, so it is not taken for the remote or refspec. */
const WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

/**
 * The `git push` commands in a shell command line, resolving `cd <dir>` and `git -C <dir>` against `cwd`.
 * Pushes of tags, deletions, mirrors and dry runs are skipped.
 */
export function pushes(command: string, cwd: string): Push[] {
  const found: Push[] = [];
  let dir = cwd;
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = tokens(segment);
    if (words[0] === 'cd' && words[1]) dir = within(dir, words[1]);
    else if (words[0] === 'git') {
      const push = gitPush(words, dir);
      if (push) found.push(push);
    }
  }
  return found;
}

/** Git Bash spells `C:\x` as `/c/x`; Node on Windows reads that as `\c\x` on the current drive, where git cannot start (spawn ENOENT). */
export const nativePath = (path: string, platform: string = process.platform) =>
  platform === 'win32' ? path.replace(/^\/([A-Za-z])(?:\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:/`) : path;
const within = (dir: string, path: string) => {
  const native = nativePath(path);
  return isAbsolute(native) || /^[A-Za-z]:[\\/]/.test(native) ? native : resolve(dir, native);
};

/** One `git [-C dir] [-c k=v] push [options] [remote [refspec]]` command, or undefined when it pushes no branch. */
function gitPush(words: string[], dir: string): Push | undefined {
  let at = 1, here = dir;
  while (words[at]?.startsWith('-')) {
    if (words[at] === '-C' && words[at + 1]) here = within(here, words[at + 1]);
    at += words[at] === '-C' || words[at] === '-c' ? 2 : 1;
  }
  const args = words.slice(at + 1);
  if (words[at] !== 'push' || args.some(a => NOT_A_BRANCH_PUSH.has(a))) return undefined;
  const positional = args.filter((a, i) => !a.startsWith('-') && !/[<>]/.test(a) && !WITH_VALUE.has(args[i - 1]));
  const refspec = positional[1] ?? '';
  if (refspec.startsWith(':') || refspec.endsWith(':')) return undefined;
  const branch = refspec.replace(/^\+/, '').split(':').pop()!.replace(/^refs\/heads\//, '');
  if (branch.startsWith('refs/')) return undefined;
  return { dir: here, remote: positional[0] ?? 'origin', ...branch && branch !== 'HEAD' ? { branch } : {} };
}

/** Resolves a push to `owner/name` and branch through the local repository; undefined when it is not a GitHub branch push. */
export async function resolvePush(push: Push, git: GitRunner): Promise<{ repo: string; branch: string; clone?: string } | undefined> {
  const url = /^(https?:|git@|ssh:)/.test(push.remote) ? push.remote : await git(['remote', 'get-url', push.remote], push.dir);
  const repo = githubRepo(url);
  const branch = push.branch ?? await git(['rev-parse', '--abbrev-ref', 'HEAD'], push.dir);
  if (!repo || !branch || branch === 'HEAD' || !BRANCH.test(branch)) return undefined;
  const clone = await git(['rev-parse', '--show-toplevel'], push.dir).catch(() => '');
  return { repo, branch, ...clone ? { clone } : {} };
}
