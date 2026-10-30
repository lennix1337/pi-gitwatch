/** GitHub pull-request state reduced to the fields that decide what to do next, and the transitions worth reporting. */

export type ChecksState = 'none' | 'pending' | 'pass' | 'fail';
export interface Checks {
  state: ChecksState; pass: number; fail: number; pending: number; skipped: number; failing: string[];
  /** GitHub Actions run ids of the failing checks, for `gh run view <id> --log-failed`. */
  runs: number[];
}
export interface Snapshot {
  number: number; title: string; url: string; author: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED'; draft: boolean;
  /** GitHub mergeStateStatus: CLEAN, BLOCKED, DIRTY, UNSTABLE, BEHIND, HAS_HOOKS, DRAFT or UNKNOWN (still computing). */
  mergeState: string;
  review: string | null; head: string; auto: boolean; mergeCommit: string | null; checks: Checks;
  /** When checks were first seen passing on this head with auto-merge on, and whether the stall was reported. */
  passedAt?: number; stallReported?: boolean;
}
/** The latest commit of a watched branch: its CI is reported once when it finishes, then the branch watch ends. */
export interface BranchSnapshot { branch: string; head: string; headline: string; checks: Checks; reported: boolean }
export type EventKind = 'opened' | 'merged' | 'closed' | 'reopened' | 'push' | 'checks' | 'mergeState' | 'review' | 'ready' | 'draft' | 'stall';
/** `pr` is 0 for branch and watcher events; `branch` names the branch of a branch event. */
export interface WatchEvent { pr: number; branch?: string; kind: EventKind; text: string; wake: boolean }

interface RawContext {
  __typename?: string; name?: string; status?: string; conclusion?: string | null; context?: string; state?: string;
  detailsUrl?: string | null; targetUrl?: string | null;
}
export interface RawCommit { oid: string; messageHeadline: string; statusCheckRollup: { contexts: { nodes: RawContext[] } } | null }
export interface RawPullRequest {
  number: number; title: string; url: string; state: string; isDraft: boolean; mergeStateStatus: string; reviewDecision: string | null;
  headRefOid: string; author: { login: string } | null; autoMergeRequest: unknown; mergeCommit: { oid: string } | null;
  commits?: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: RawContext[] } } | null } }[] };
}

const PASS = new Set(['SUCCESS', 'NEUTRAL']);
const SKIP = new Set(['SKIPPED']);
type Verdict = 'pass' | 'fail' | 'pending' | 'skip';
function verdict(c: RawContext): Verdict {
  if (c.__typename === 'StatusContext' || c.context !== undefined) {
    const s = c.state ?? '';
    return s === 'SUCCESS' ? 'pass' : s === 'PENDING' || s === 'EXPECTED' ? 'pending' : 'fail';
  }
  if (c.status !== 'COMPLETED') return 'pending';
  const result = c.conclusion ?? '';
  return PASS.has(result) ? 'pass' : SKIP.has(result) ? 'skip' : 'fail';
}

/** The GitHub Actions run behind a check, from its details link. */
const runId = (c: RawContext) => Number(/\/actions\/runs\/(\d+)/.exec(c.detailsUrl ?? c.targetUrl ?? '')?.[1]) || undefined;

/** The Actions runs of the failed attempts of the failing checks, ascending. */
function failedRuns(contexts: RawContext[], failing: string[]): number[] {
  const runs = contexts.filter(c => failing.includes(c.name ?? c.context ?? '?') && verdict(c) === 'fail').map(runId);
  return [...new Set(runs.filter((id): id is number => id !== undefined))].sort((a, b) => a - b);
}

/** One verdict per check name: a rerun or a duplicate workflow cancelled next to a passing twin is not a failure. */
export function summarizeChecks(contexts: RawContext[]): Checks {
  const byName = new Map<string, Verdict[]>();
  for (const c of contexts) byName.set(c.name ?? c.context ?? '?', [...byName.get(c.name ?? c.context ?? '?') ?? [], verdict(c)]);
  const checks: Checks = { state: 'none', pass: 0, fail: 0, pending: 0, skipped: 0, failing: [], runs: [] };
  for (const [name, verdicts] of byName) {
    if (verdicts.includes('pending')) checks.pending++;
    else if (verdicts.includes('pass')) checks.pass++;
    else if (verdicts.every(v => v === 'skip')) checks.skipped++;
    else { checks.fail++; checks.failing.push(name); }
  }
  checks.failing.sort();
  checks.runs = failedRuns(contexts, checks.failing);
  checks.state = checks.pending > 0 ? 'pending' : checks.fail > 0 ? 'fail' : checks.pass > 0 ? 'pass' : 'none';
  return checks;
}

export function normalize(raw: RawPullRequest): Snapshot {
  const rollup = raw.commits?.nodes[0]?.commit.statusCheckRollup;
  const state = raw.state === 'MERGED' || raw.state === 'CLOSED' ? raw.state : 'OPEN';
  return {
    number: raw.number, title: raw.title, url: raw.url, author: raw.author?.login ?? 'ghost', state, draft: raw.isDraft,
    mergeState: raw.mergeStateStatus, review: raw.reviewDecision, head: raw.headRefOid.slice(0, 8), auto: raw.autoMergeRequest != null,
    mergeCommit: raw.mergeCommit?.oid.slice(0, 8) ?? null, checks: summarizeChecks(rollup?.contexts.nodes ?? []),
  };
}

/** GitHub reports UNKNOWN while it recomputes mergeability; keep the last known value instead of reporting a flap. */
export function settle(prev: Snapshot | undefined, cur: Snapshot): Snapshot {
  return cur.mergeState === 'UNKNOWN' && prev && prev.head === cur.head ? { ...cur, mergeState: prev.mergeState } : cur;
}

const MERGE_STATE_TEXT: Record<string, string> = {
  CLEAN: 'mergeable (CLEAN)', DIRTY: 'merge conflict with base (DIRTY)', BEHIND: 'behind base (BEHIND)',
  BLOCKED: 'blocked by required checks or reviews (BLOCKED)', UNSTABLE: 'mergeable with non-required failures (UNSTABLE)',
};

/** The transitions from `prev` to `cur`. `wake` marks those the agent must act on; the rest ride along in the same notice. */
export function diff(prev: Snapshot | undefined, cur: Snapshot): WatchEvent[] {
  const pr = cur.number;
  if (!prev) return [{ pr, kind: 'opened', text: `opened by ${cur.author}`, wake: false }];
  if (cur.state !== prev.state) {
    if (cur.state === 'MERGED') return [{ pr, kind: 'merged', text: `merged${cur.mergeCommit ? ` ${cur.mergeCommit}` : ''}`, wake: true }];
    if (cur.state === 'CLOSED') return [{ pr, kind: 'closed', text: 'closed without merge', wake: true }];
    return [{ pr, kind: 'reopened', text: 'reopened', wake: true }];
  }
  if (cur.state !== 'OPEN') return [];
  const events: WatchEvent[] = [];
  if (cur.head !== prev.head) events.push({ pr, kind: 'push', text: `new head ${cur.head}`, wake: false });
  const a = prev.checks, b = cur.checks;
  if (b.state !== a.state || (b.state === 'fail' && b.failing.join() !== a.failing.join())) {
    // With auto-merge on, passing checks need nothing from the agent: the merge (or a stall) is what gets reported.
    if (b.state === 'pass') events.push({ pr, kind: 'checks', text: passedText(b), wake: !cur.auto });
    else if (b.state === 'fail') events.push({ pr, kind: 'checks', text: `checks failed: ${b.failing.join(', ')}`, wake: b.pending === 0 || a.state !== 'fail' });
    else if (b.state === 'pending') events.push({ pr, kind: 'checks', text: `checks running (${b.pending} pending)`, wake: false });
  }
  if (cur.mergeState !== prev.mergeState && cur.mergeState !== 'UNKNOWN') {
    const wake = cur.mergeState === 'DIRTY' || (cur.mergeState === 'BEHIND' && b.state !== 'pending') || (cur.mergeState === 'CLEAN' && !cur.auto && !cur.draft);
    events.push({ pr, kind: 'mergeState', text: MERGE_STATE_TEXT[cur.mergeState] ?? cur.mergeState, wake });
  }
  if (cur.draft !== prev.draft) events.push({ pr, kind: cur.draft ? 'draft' : 'ready', text: cur.draft ? 'converted to draft' : 'ready for review', wake: false });
  if (cur.review !== prev.review && cur.review) events.push({ pr, kind: 'review', text: `review ${cur.review.toLowerCase().replace('_', ' ')}`, wake: cur.review === 'CHANGES_REQUESTED' || cur.review === 'APPROVED' });
  return events;
}

const passedText = (c: Checks) => `checks passed ${c.pass}/${c.pass + c.fail}${c.skipped ? `, ${c.skipped} skipped` : ''}`;

/** How long auto-merge may sit on a PR whose checks passed before the agent is told it is stuck. */
export const AUTO_MERGE_STALL_MS = 10 * 60_000;

/**
 * Tracks an auto-merge PR whose checks passed on this head; once it has stayed open for `stallMs`, returns one waking
 * event (a missing review or rule usually blocks it). Returns the snapshot to store.
 */
export function autoMergeStall(prev: Snapshot | undefined, cur: Snapshot, now: number, stallMs = AUTO_MERGE_STALL_MS): { snapshot: Snapshot; event?: WatchEvent } {
  if (cur.state !== 'OPEN' || !cur.auto || cur.checks.state !== 'pass') return { snapshot: { ...cur, passedAt: undefined, stallReported: undefined } };
  const same = prev?.head === cur.head && prev.passedAt !== undefined;
  const passedAt = same ? prev!.passedAt! : now;
  const snapshot: Snapshot = { ...cur, passedAt, stallReported: same ? prev!.stallReported : false };
  if (snapshot.stallReported || now - passedAt < stallMs) return { snapshot };
  snapshot.stallReported = true;
  const minutes = Math.round((now - passedAt) / 60_000);
  return { snapshot, event: { pr: cur.number, kind: 'stall', text: `auto-merge has not merged ${minutes} min after checks passed (${cur.mergeState})`, wake: true } };
}

const isFinal = (c: Checks) => c.pending === 0 && (c.state === 'pass' || c.state === 'fail');

export function normalizeBranch(branch: string, raw: RawCommit): BranchSnapshot {
  return { branch, head: raw.oid.slice(0, 8), headline: raw.messageHeadline, checks: summarizeChecks(raw.statusCheckRollup?.contexts.nodes ?? []), reported: false };
}

/** A new watch is a baseline: CI already finished at that point is not announced again. */
export const baselineBranch = (s: BranchSnapshot): BranchSnapshot => ({ ...s, reported: isFinal(s.checks) });

/** Branch transitions: a new head rides along; its CI finishing wakes once. Returns the snapshot to store. */
export function branchDiff(prev: BranchSnapshot | undefined, cur: BranchSnapshot): { snapshot: BranchSnapshot; events: WatchEvent[] } {
  if (!prev) return { snapshot: baselineBranch(cur), events: [] };
  const events: WatchEvent[] = [];
  const branch = cur.branch;
  const reported = prev.head === cur.head && prev.reported;
  if (prev.head !== cur.head) events.push({ pr: 0, branch, kind: 'push', text: `new commit ${cur.head}`, wake: false });
  if (!reported && isFinal(cur.checks)) {
    const c = cur.checks;
    events.push({ pr: 0, branch, kind: 'checks', text: c.state === 'pass' ? passedText(c) : `checks failed: ${c.failing.join(', ')}`, wake: true });
    return { snapshot: { ...cur, reported: true }, events };
  }
  return { snapshot: { ...cur, reported }, events };
}

/** The command that shows why a check failed: the Actions log when the run is known, else the PR checks. */
function failingLog(c: Checks, repo: string, pr?: number): string {
  if (c.runs.length) return `read the failing job log: ${c.runs.slice(0, 3).map(id => `gh run view ${id} --repo ${repo} --log-failed`).join(' ; ')}`;
  return pr ? `read the failing job log: gh pr checks ${pr} --repo ${repo}` : 'open the failing check on GitHub';
}

/** Wall-clock time as the operator reads it: Brasília. */
export const brt = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

const short = (s: string, n = 60) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

const checksText = (c: Checks) => c.state === 'none' ? 'no checks' : `checks ${c.state} ${c.pass}✓ ${c.fail}✗ ${c.pending}…${c.failing.length ? ` [${c.failing.join(', ')}]` : ''}`;

/** One compact line per watched branch: its latest commit and CI. */
export function branchLine(s: BranchSnapshot): string {
  return `${s.branch} @${s.head} · ${checksText(s.checks)}${s.reported ? ' · CI finished, watch ends' : ''} · "${short(s.headline)}"`;
}

export function branchHint(s: BranchSnapshot, repo: string): string | undefined {
  return s.checks.state === 'fail' && s.checks.pending === 0 ? failingLog(s.checks, repo) : undefined;
}

/** One compact line per PR: the fields that decide the next action. */
export function line(s: Snapshot): string {
  const checks = checksText(s.checks);
  const flags = [s.draft && 'draft', s.auto && 'auto-merge', s.review && s.review.toLowerCase()].filter(Boolean).join(' ');
  const state = s.state === 'OPEN' ? s.mergeState : `${s.state}${s.mergeCommit ? ` ${s.mergeCommit}` : ''}`;
  return `#${s.number} ${state} · ${checks}${flags ? ` · ${flags}` : ''} · ${s.head} · ${s.author} · "${short(s.title)}"`;
}

/** What the agent probably does next for a PR in this state; omitted when nothing is actionable. */
export function hint(s: Snapshot, repo: string): string | undefined {
  if (s.state !== 'OPEN') return undefined;
  if (s.mergeState === 'DIRTY') return 'merge the base branch into the head and resolve the conflict';
  if (s.checks.state === 'fail') return failingLog(s.checks, repo, s.number);
  if (s.mergeState === 'BEHIND') return 'update the branch with the base';
  if (s.mergeState === 'CLEAN' && !s.auto && !s.draft) return 'ready to merge';
  if (s.stallReported) return `auto-merge is waiting on a review or rule: gh pr view ${s.number} --repo ${repo} --json mergeStateStatus,reviewDecision`;
  return undefined;
}
