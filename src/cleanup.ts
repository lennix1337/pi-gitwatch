import { existsSync } from 'node:fs';
import type { GitRunner } from './autowatch.ts';
import { isLoadedPackage } from './packages.ts';

/** Long-lived branches are never cleaned, even when one happens to point at a merged PR head. */
const PROTECTED = new Set(['main', 'master', 'trunk', 'develop']);

/** The last line of a failure: execFile puts git's stderr after a "Command failed" line, and its last line names the reason. */
const lastLine = (error: unknown) => String((error as Error).message ?? error).split(/\r?\n/).filter(l => l.trim()).pop();

interface Worktree { path: string; branch?: string; main: boolean }

/** `git worktree list --porcelain`: blocks of `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<name>`; the first is the main one. */
export function parseWorktrees(porcelain: string): Worktree[] {
  return porcelain.split(/\r?\n\r?\n/).filter(b => b.trim()).map((block, i) => {
    const lines = block.split(/\r?\n/);
    const path = lines.find(l => l.startsWith('worktree '))?.slice(9) ?? '';
    const branch = lines.find(l => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '');
    return { path, main: i === 0, ...branch ? { branch } : {} };
  });
}

/**
 * After a PR merged, removes the local branches of `clone` that still point exactly at its head commit (so every commit
 * they hold is in the merged PR), and the linked worktree that has one checked out. Git refuses to remove a worktree
 * with modified or untracked files, so uncommitted work is kept; a worktree whose folder is already gone is pruned; the main worktree's branch and long-lived branches are
 * kept too. Returns one line per branch found.
 */
export async function cleanMerged(git: GitRunner, clone: string, head: string): Promise<string[]> {
  // A contributor's PR head this clone never fetched: no local branch can point at it, so there is nothing to clean.
  try { await git(['rev-parse', '--verify', '--quiet', `${head}^{commit}`], clone); } catch { return []; }
  const refs = await git(['for-each-ref', '--points-at', head, '--format=%(refname:short)', 'refs/heads'], clone);
  const branches = refs.split(/\r?\n/).map(b => b.trim()).filter(b => b && !PROTECTED.has(b));
  if (!branches.length) return [];
  const trees = parseWorktrees(await git(['worktree', 'list', '--porcelain'], clone));
  // Mutate from the main worktree: `clone` may be a linked worktree that is itself about to go away or is unrelated.
  const main = trees[0]?.path && existsSync(trees[0].path) ? trees[0].path : clone;
  const lines: string[] = [];
  for (const branch of branches) {
    const tree = trees.find(t => t.branch === branch);
    if (tree?.main) { lines.push(`kept ${branch}: checked out in ${tree.path}`); continue; }
    try {
      // A worktree whose folder is already gone (git lists it as prunable) has nothing to remove: drop its record.
      if (tree) await git(existsSync(tree.path) ? ['worktree', 'remove', tree.path] : ['worktree', 'prune'], main);
      await git(['branch', '-D', branch], main);
      lines.push(`removed ${tree ? `worktree ${tree.path} and ` : ''}branch ${branch}`);
    } catch (error) {
      // execFile puts git's stderr after a "Command failed" line; its last line names the reason.
      const reason = String((error as Error).message ?? error).split(/\r?\n/).filter(l => l.trim()).pop();
      lines.push(`kept ${branch}: ${reason}`);
    }
  }
  return lines;
}

/** One local cleanup result, tied to the PR whose merge caused it. `left`: something stayed for the agent to do. */
export interface CleanupLine { pr: number; text: string; left?: true }

/** The branch the repository's default is, from `origin/HEAD`, else the usual names; `main` and `master` only as a fallback. */
async function defaultBranch(git: GitRunner, dir: string): Promise<string[]> {
  const ref = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir).catch(() => '');
  return ref.startsWith('origin/') ? [ref.slice('origin/'.length)] : ['main', 'master'];
}

/**
 * Brings the main checkout up to date with its upstream after a merge, only when that is plain: it is on the default
 * branch, has no uncommitted change to tracked files (git itself refuses to overwrite an untracked one) and the fast-forward is possible. Never stashes, resets or
 * merges. Returns the line to report, or undefined when it is already up to date; a skip is `left`.
 */
export async function fastForwardMain(git: GitRunner, main: string): Promise<{ text: string; left?: true } | undefined> {
  const skip = (why: string) => ({ text: `skipped fast-forward of ${main}: ${why}`, left: true as const });
  try {
    const branch = await git(['symbolic-ref', '--short', 'HEAD'], main).catch(() => '');
    if (!branch) return skip('HEAD is detached');
    const defaults = await defaultBranch(git, main);
    if (!defaults.includes(branch)) return skip(`it is on ${branch}, not ${defaults.join('/')}`);
    if (await git(['status', '--porcelain', '--untracked-files=no'], main)) return skip('it has uncommitted changes');
    const upstream = await git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], main).catch(() => '');
    if (!upstream) return skip(`${branch} has no upstream`);
    await git(['fetch', '--quiet', upstream.slice(0, upstream.indexOf('/'))], main);
    const [ahead, behind] = (await git(['rev-list', '--left-right', '--count', `${branch}...${upstream}`], main)).split(/\s+/).map(Number);
    if (!behind) return undefined;
    if (ahead) return skip(`${branch} diverged from ${upstream} (${ahead} ahead, ${behind} behind)`);
    await git(['merge', '--ff-only', '--quiet', upstream], main);
    return { text: `fast-forwarded ${branch} in ${main} to ${await git(['rev-parse', '--short', 'HEAD'], main)} (${behind} commit${behind === 1 ? '' : 's'})` };
  } catch (error) { return skip(lastLine(error) ?? 'git failed'); }
}

/** Folders of the Pi packages the settings load: a merge into one of them is not live until Pi reloads. */
export interface CleanupOptions { packages?: string[] }

/**
 * The cleanup results for each merged event of a clone, then one fast-forward of its main checkout and, for a loaded
 * Pi package, a `reload needed` line. A line is `left` when it asks something of the agent. A clone the agent already
 * removed cannot be cleaned: that is `left` too. Never throws.
 */
export async function cleanupLines(git: GitRunner, notice: { clone?: string; events: { kind: string; pr: number; head?: string }[] }, options: CleanupOptions = {}): Promise<CleanupLine[]> {
  if (!notice.clone) return [];
  const merged = notice.events.filter(e => e.kind === 'merged' && e.head);
  if (!merged.length) return [];
  if (!existsSync(notice.clone)) return merged.map(e => ({ pr: e.pr, text: `cleanup skipped: ${notice.clone} no longer exists, so its main checkout was not updated`, left: true as const }));
  // Found first: removing a merged linked worktree may delete the folder this clone names.
  const main = await mainCheckout(git, notice.clone);
  const lines: CleanupLine[] = [];
  for (const e of merged) {
    try {
      for (const text of await cleanMerged(git, notice.clone, e.head!)) lines.push({ pr: e.pr, text, ...text.startsWith('removed ') ? {} : { left: true as const } });
    } catch (error) { lines.push({ pr: e.pr, text: `cleanup skipped: ${lastLine(error)}`, left: true }); }
  }
  // The checkout to update and to reload is the main one, whichever linked worktree the push came from.
  const pr = merged[merged.length - 1].pr;
  const forward = await fastForwardMain(git, main);
  if (forward) lines.push({ pr, ...forward });
  if (isLoadedPackage(main, options.packages ?? [])) lines.push({ pr, text: `reload needed: ${main} is a loaded Pi package`, left: true });
  return lines;
}

/** The main worktree of the repository `clone` belongs to; `clone` itself when git cannot say. */
async function mainCheckout(git: GitRunner, clone: string): Promise<string> {
  const first = parseWorktrees(await git(['worktree', 'list', '--porcelain'], clone).catch(() => ''))[0]?.path;
  return first && existsSync(first) ? first : clone;
}
