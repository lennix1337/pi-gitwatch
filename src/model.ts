/** GitHub pull-request state reduced to the fields that decide what to do next, and the transitions worth reporting. */

export type ChecksState = 'none' | 'pending' | 'pass' | 'fail';
export interface Checks { state: ChecksState; pass: number; fail: number; pending: number; skipped: number; failing: string[] }
export interface Snapshot {
  number: number; title: string; url: string; author: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED'; draft: boolean;
  /** GitHub mergeStateStatus: CLEAN, BLOCKED, DIRTY, UNSTABLE, BEHIND, HAS_HOOKS, DRAFT or UNKNOWN (still computing). */
  mergeState: string;
  review: string | null; head: string; auto: boolean; mergeCommit: string | null; checks: Checks;
}
export type EventKind = 'opened' | 'merged' | 'closed' | 'reopened' | 'push' | 'checks' | 'mergeState' | 'review' | 'ready' | 'draft';
export interface WatchEvent { pr: number; kind: EventKind; text: string; wake: boolean }

interface RawContext { __typename?: string; name?: string; status?: string; conclusion?: string | null; context?: string; state?: string }
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

/** One verdict per check name: a rerun or a duplicate workflow cancelled next to a passing twin is not a failure. */
export function summarizeChecks(contexts: RawContext[]): Checks {
  const byName = new Map<string, Verdict[]>();
  for (const c of contexts) {
    const name = c.name ?? c.context ?? '?';
    byName.set(name, [...byName.get(name) ?? [], verdict(c)]);
  }
  const checks: Checks = { state: 'none', pass: 0, fail: 0, pending: 0, skipped: 0, failing: [] };
  for (const [name, verdicts] of byName) {
    if (verdicts.includes('pending')) checks.pending++;
    else if (verdicts.includes('pass')) checks.pass++;
    else if (verdicts.every(v => v === 'skip')) checks.skipped++;
    else { checks.fail++; checks.failing.push(name); }
  }
  checks.failing.sort();
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
    if (b.state === 'pass') events.push({ pr, kind: 'checks', text: `checks passed ${b.pass}/${b.pass + b.fail}${b.skipped ? `, ${b.skipped} skipped` : ''}`, wake: true });
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

/** Wall-clock time as the operator reads it: Brasília. */
export const brt = (ms: number) => new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

const short = (s: string, n = 60) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** One compact line per PR: the fields that decide the next action. */
export function line(s: Snapshot): string {
  const c = s.checks;
  const checks = c.state === 'none' ? 'no checks' : `checks ${c.state} ${c.pass}✓ ${c.fail}✗ ${c.pending}…${c.failing.length ? ` [${c.failing.join(', ')}]` : ''}`;
  const flags = [s.draft && 'draft', s.auto && 'auto-merge', s.review && s.review.toLowerCase()].filter(Boolean).join(' ');
  const state = s.state === 'OPEN' ? s.mergeState : `${s.state}${s.mergeCommit ? ` ${s.mergeCommit}` : ''}`;
  return `#${s.number} ${state} · ${checks}${flags ? ` · ${flags}` : ''} · ${s.head} · ${s.author} · "${short(s.title)}"`;
}

/** What the agent probably does next for a PR in this state; omitted when nothing is actionable. */
export function hint(s: Snapshot, repo: string): string | undefined {
  if (s.state !== 'OPEN') return undefined;
  if (s.mergeState === 'DIRTY') return 'merge the base branch into the head and resolve the conflict';
  if (s.checks.state === 'fail') return `read the failing job log: gh pr checks ${s.number} --repo ${repo}`;
  if (s.mergeState === 'BEHIND') return 'update the branch with the base';
  if (s.mergeState === 'CLEAN' && !s.auto && !s.draft) return 'ready to merge';
  return undefined;
}
