import { execFile } from 'node:child_process';
import type { RawCommit, RawPullRequest } from './model.ts';

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
export const MAX_BRANCHES = 10;
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Branch names the watcher accepts; they are embedded in the GraphQL query as JSON string literals. */
export const BRANCH = /^[A-Za-z0-9._\/-]{1,200}$/;

const ROLLUP = `statusCheckRollup { contexts(first: 100) { nodes { __typename
  ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } }`;
const FIELDS = `number title url state isDraft mergeStateStatus reviewDecision headRefOid author { login } autoMergeRequest { enabledAt } mergeCommit { oid }
  commits(last: 1) { nodes { commit { ${ROLLUP} } } }`;
const literal = (s: string) => JSON.stringify(s);

export function query(numbers: number[], open: boolean, branches: string[] = []): string {
  const parts = numbers.map(n => `p${n}: pullRequest(number: ${n}) { ...F }`);
  if (open) parts.push(`open: pullRequests(states: OPEN, first: ${MAX_PRS}, orderBy: { field: CREATED_AT, direction: ASC }) { nodes { ...F } }`);
  // GitHub rejects a document that defines a fragment it never uses, as a branch-only query would.
  const fragment = parts.length ? `\nfragment F on PullRequest { ${FIELDS} }` : '';
  branches.forEach((b, i) => parts.push(`b${i}: ref(qualifiedName: ${literal(`refs/heads/${b}`)}) { target { ... on Commit { oid messageHeadline ${ROLLUP} } } }`));
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${parts.join(' ')} } }${fragment}`;
}

export interface Fetched { prs: Map<number, RawPullRequest>; open?: number[]; branches: Map<string, RawCommit | null> }

async function graphql(run: Runner, repo: string, body: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const [owner, name] = repo.split('/');
  const out = await run(['api', 'graphql', '-f', `query=${body}`, '-F', `owner=${owner}`, '-F', `name=${name}`], signal);
  const parsed = JSON.parse(out) as { data?: { repository: Record<string, unknown> | null }; errors?: { message: string }[] };
  const repository = parsed.data?.repository;
  if (!repository) throw new Error(parsed.errors?.map(e => e.message).join('; ').slice(0, 300) || `repository ${repo} not found`);
  return repository;
}

/** One GraphQL call per repository: the named PRs, every open PR when `open` is set, and the head commit of each branch. */
export async function fetchRepo(run: Runner, repo: string, numbers: number[], open: boolean, signal?: AbortSignal, branches: string[] = []): Promise<Fetched> {
  const repository = await graphql(run, repo, query(numbers, open, branches), signal);
  const prs = new Map<number, RawPullRequest>();
  const heads = new Map<string, RawCommit | null>();
  let openNumbers: number[] | undefined;
  for (const [key, value] of Object.entries(repository)) {
    if (key === 'open') {
      const nodes = (value as { nodes: RawPullRequest[] }).nodes;
      for (const pr of nodes) prs.set(pr.number, pr);
      openNumbers = nodes.map(pr => pr.number);
    } else if (/^b\d+$/.test(key)) {
      const target = (value as { target?: RawCommit } | null)?.target;
      heads.set(branches[Number(key.slice(1))], target?.oid ? target : null);
    } else if (value) prs.set((value as RawPullRequest).number, value as RawPullRequest);
  }
  return { prs, open: openNumbers, branches: heads };
}

/** The open PR whose head is `branch` in `repo`, if any (same-repository heads only). */
export async function openPrFor(run: Runner, repo: string, branch: string, signal?: AbortSignal): Promise<number | undefined> {
  const repository = await graphql(run, repo, `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
  head: pullRequests(headRefName: ${literal(branch)}, states: OPEN, first: 10) { nodes { number headRepository { nameWithOwner } } } } }`, signal);
  const nodes = (repository.head as { nodes: { number: number; headRepository: { nameWithOwner: string } | null }[] } | undefined)?.nodes ?? [];
  return nodes.find(n => n.headRepository?.nameWithOwner.toLowerCase() === repo.toLowerCase())?.number;
}
