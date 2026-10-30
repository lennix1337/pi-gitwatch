import { execFile } from 'node:child_process';
import type { RawPullRequest } from './model.ts';

/** Runs `gh` with arguments and resolves its stdout. Injected in tests. */
export type Runner = (args: string[], signal?: AbortSignal) => Promise<string>;

export const ghRunner: Runner = (args, signal) => new Promise((resolve, reject) => {
  execFile('gh', args, { timeout: 30_000, maxBuffer: 16 << 20, windowsHide: true, signal }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    const detail = (stderr || error.message).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
    reject(new Error(detail.slice(0, 300) || 'gh failed'));
  });
});

export const MAX_PRS = 50;
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const FIELDS = `number title url state isDraft mergeStateStatus reviewDecision headRefOid author { login } autoMergeRequest { enabledAt } mergeCommit { oid }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename
    ... on CheckRun { name status conclusion } ... on StatusContext { context state } } } } } } }`;

export function query(numbers: number[], open: boolean): string {
  const parts = numbers.map(n => `p${n}: pullRequest(number: ${n}) { ...F }`);
  if (open) parts.push(`open: pullRequests(states: OPEN, first: ${MAX_PRS}, orderBy: { field: CREATED_AT, direction: ASC }) { nodes { ...F } }`);
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${parts.join(' ')} } }
fragment F on PullRequest { ${FIELDS} }`;
}

export interface Fetched { prs: Map<number, RawPullRequest>; open?: number[] }

/** One GraphQL call per repository: the named PRs, plus every open PR when `open` is set. */
export async function fetchRepo(run: Runner, repo: string, numbers: number[], open: boolean, signal?: AbortSignal): Promise<Fetched> {
  const [owner, name] = repo.split('/');
  const out = await run(['api', 'graphql', '-f', `query=${query(numbers, open)}`, '-F', `owner=${owner}`, '-F', `name=${name}`], signal);
  const body = JSON.parse(out) as { data?: { repository: Record<string, unknown> | null }; errors?: { message: string }[] };
  const repository = body.data?.repository;
  if (!repository) throw new Error(body.errors?.map(e => e.message).join('; ').slice(0, 300) || `repository ${repo} not found`);
  const prs = new Map<number, RawPullRequest>();
  let openNumbers: number[] | undefined;
  for (const [key, value] of Object.entries(repository)) {
    if (key === 'open') {
      const nodes = (value as { nodes: RawPullRequest[] }).nodes;
      for (const pr of nodes) prs.set(pr.number, pr);
      openNumbers = nodes.map(pr => pr.number);
    } else if (value) prs.set((value as RawPullRequest).number, value as RawPullRequest);
  }
  return { prs, open: openNumbers };
}
