import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner } from '../src/github.ts';
import type { RawPullRequest } from '../src/model.ts';

export type Check = [name: string, status: string, conclusion?: string | null];
export function pr(number: number, over: Partial<RawPullRequest> = {}, checks: Check[] = [['test', 'COMPLETED', 'SUCCESS']]): RawPullRequest {
  return {
    number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, state: 'OPEN', isDraft: false, mergeStateStatus: 'BLOCKED',
    reviewDecision: null, headRefOid: `${number}`.padEnd(40, 'a'), author: { login: 'dev' }, autoMergeRequest: null, mergeCommit: null,
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: checks.map(([name, status, conclusion]) => ({ __typename: 'CheckRun', name, status, conclusion: conclusion ?? null })) } } } }] },
    ...over,
  };
}

/** A fake `gh api graphql`: serves the current PR table for the aliases and open list the query asks for. */
export class FakeGitHub {
  prs = new Map<number, RawPullRequest>();
  calls: string[][] = [];
  fail?: string;
  set(...items: RawPullRequest[]) { for (const p of items) this.prs.set(p.number, p); }
  run: Runner = async args => {
    this.calls.push(args);
    if (this.fail) throw new Error(this.fail);
    const query = args[args.indexOf('-f') + 1];
    const repository: Record<string, unknown> = {};
    for (const [, n] of query.matchAll(/p(\d+): pullRequest/g)) repository[`p${n}`] = this.prs.get(Number(n)) ?? null;
    if (query.includes('open: pullRequests')) repository.open = { nodes: [...this.prs.values()].filter(p => p.state === 'OPEN') };
    return JSON.stringify({ data: { repository } });
  };
}

export const tempDir = () => mkdtempSync(join(tmpdir(), 'gitwatch-'));
