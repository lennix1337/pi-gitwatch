import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner } from '../src/github.ts';
import type { RawCommit, RawPullRequest } from '../src/model.ts';

export type Check = [name: string, status: string, conclusion?: string | null, startedAt?: string | null];
export function pr(number: number, over: Partial<RawPullRequest> = {}, checks: Check[] = [['test', 'COMPLETED', 'SUCCESS']]): RawPullRequest {
  return {
    number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, state: 'OPEN', isDraft: false, mergeStateStatus: 'BLOCKED',
    reviewDecision: null, headRefOid: `${number}`.padEnd(40, 'a'), author: { login: 'dev' }, autoMergeRequest: null, mergeCommit: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks.map(([name, status, conclusion, startedAt]) => ({ __typename: 'CheckRun', name, status, conclusion: conclusion ?? null, ...startedAt ? { startedAt } : {} })) } } } }] },
    ...over,
  };
}

/** A branch head commit with check runs; `run` sets the Actions run id in each check's details URL. */
export function commit(oid: string, checks: Check[] = [['test', 'COMPLETED', 'SUCCESS']], run = 900): RawCommit {
  return {
    oid: oid.padEnd(40, '0'), messageHeadline: `commit ${oid}`,
    statusCheckRollup: { contexts: { nodes: checks.map(([name, status, conclusion, startedAt]) => ({ __typename: 'CheckRun', name, status, conclusion: conclusion ?? null, ...startedAt ? { startedAt } : {}, detailsUrl: `https://github.com/o/r/actions/runs/${run}/job/1` })) } },
  };
}

/** A fake `gh api graphql`: serves the current PR table for the aliases and open list the query asks for. */
export class FakeGitHub {
  prs = new Map<number, RawPullRequest>();
  /** Branch name to head commit. */
  branches = new Map<string, RawCommit>();
  /** Branch name to the number of its open PR. */
  heads = new Map<string, number>();
  calls: string[][] = [];
  fail?: string;
  set(...items: RawPullRequest[]) { for (const p of items) this.prs.set(p.number, p); }
  run: Runner = async args => {
    this.calls.push(args);
    if (this.fail) throw new Error(this.fail);
    const query = args[args.indexOf('-f') + 1];
    // Like GitHub: a fragment defined but never spread fails the whole request.
    if (query.includes('fragment F ') && !query.includes('...F')) throw new Error('gh: Fragment F was defined, but not used');
    const repository: Record<string, unknown> = {};
    for (const [, n] of query.matchAll(/p(\d+): pullRequest/g)) repository[`p${n}`] = this.prs.get(Number(n)) ?? null;
    if (query.includes('open: pullRequests')) repository.open = { nodes: [...this.prs.values()].filter(p => p.state === 'OPEN') };
    for (const [, alias, name] of query.matchAll(/(b\d+): ref\(qualifiedName: "refs\/heads\/([^"]+)"\)/g)) {
      const head = this.branches.get(name);
      repository[alias] = head ? { target: head } : null;
    }
    const head = /head: pullRequests\(headRefName: "([^"]+)"/.exec(query)?.[1];
    if (head) {
      const n = this.heads.get(head);
      repository.head = { nodes: n ? [{ number: n, headRepository: { nameWithOwner: 'o/r' } }] : [] };
    }
    return JSON.stringify({ data: { repository } });
  };
}

export const tempDir = () => mkdtempSync(join(tmpdir(), 'gitwatch-'));

/** Runs git in `cwd` and returns its trimmed output. */
export const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/**
 * A GitHub-like setup with real git: a bare `origin`, the agent's main checkout `main` (on `main`, tracking origin/main) and a
 * second clone that plays the squash merge landing on origin. `merge()` pushes that commit.
 */
export function gitWorld() {
  const root = tempDir();
  const origin = join(root, 'origin.git'), main = join(root, 'main'), other = join(root, 'other');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, main]);
  for (const dir of [main]) { run(dir, 'config', 'user.email', 't@example.com'); run(dir, 'config', 'user.name', 't'); }
  writeFileSync(join(main, 'a.txt'), '1'); run(main, 'add', '.'); run(main, 'commit', '-qm', 'base'); run(main, 'push', '-q', 'origin', 'main');
  run(main, 'remote', 'set-head', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, other]);
  run(other, 'config', 'user.email', 't@example.com'); run(other, 'config', 'user.name', 't');
  const merge = () => { writeFileSync(join(other, 'merged.txt'), 'squash'); run(other, 'add', '.'); run(other, 'commit', '-qm', 'squash merge'); run(other, 'push', '-q', 'origin', 'main'); };
  return { root, origin, main, other, merge };
}
