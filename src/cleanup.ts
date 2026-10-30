import type { GitRunner } from './autowatch.ts';

/** Long-lived branches are never cleaned, even when one happens to point at a merged PR head. */
const PROTECTED = new Set(['main', 'master', 'trunk', 'develop']);

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
 * with modified or untracked files, so uncommitted work is kept; the main worktree's branch and long-lived branches are
 * kept too. Returns one line per branch found.
 */
export async function cleanMerged(git: GitRunner, clone: string, head: string): Promise<string[]> {
  const refs = await git(['for-each-ref', '--points-at', head, '--format=%(refname:short)', 'refs/heads'], clone);
  const branches = refs.split(/\r?\n/).map(b => b.trim()).filter(b => b && !PROTECTED.has(b));
  if (!branches.length) return [];
  const trees = parseWorktrees(await git(['worktree', 'list', '--porcelain'], clone));
  const lines: string[] = [];
  for (const branch of branches) {
    const tree = trees.find(t => t.branch === branch);
    if (tree?.main) { lines.push(`kept ${branch}: checked out in ${tree.path}`); continue; }
    try {
      if (tree) await git(['worktree', 'remove', tree.path], clone);
      await git(['branch', '-D', branch], clone);
      lines.push(`removed ${tree ? `worktree ${tree.path} and ` : ''}branch ${branch}`);
    } catch (error) {
      // execFile puts git's stderr after a "Command failed" line; its last line names the reason.
      const reason = String((error as Error).message ?? error).split(/\r?\n/).filter(l => l.trim()).pop();
      lines.push(`kept ${branch}: ${reason}`);
    }
  }
  return lines;
}

/** The note appended to a notice whose merged PRs left branches in the clone the agent pushed from; '' when none. */
export async function cleanupNote(git: GitRunner, notice: { clone?: string; events: { kind: string; pr: number; head?: string }[] }): Promise<string> {
  if (!notice.clone) return '';
  const lines: string[] = [];
  for (const e of notice.events) {
    if (e.kind !== 'merged' || !e.head) continue;
    try { lines.push(...(await cleanMerged(git, notice.clone, e.head)).map(l => `#${e.pr} ${l}`)); }
    catch (error) { lines.push(`#${e.pr} cleanup skipped: ${String((error as Error).message ?? error).split(/\r?\n/).filter(l => l.trim()).pop()}`); }
  }
  return lines.length ? `\nLocal cleanup in ${notice.clone}: ${lines.join('; ')}.` : '';
}
