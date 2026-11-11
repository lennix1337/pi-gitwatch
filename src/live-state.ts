import { hint, type BranchSnapshot, type Checks, type Snapshot, type WatchEvent } from './model.ts';
import type { State } from './watcher.ts';

/**
 * The read side other extensions use, on `pi.events`. The payloads are a contract: a field is added, never renamed or
 * repurposed; a breaking change goes out on a new channel (`:v2`). README documents them.
 */
export const STATE_CHANNEL = 'gitwatch:state:v1';
export const NOTICE_CHANNEL = 'gitwatch:notice:v1';
/** A consumer that loaded after the last poll asks for the state again; the answer is a `STATE_CHANNEL` emit. */
export const STATE_REQUEST_CHANNEL = 'gitwatch:state:request:v1';

export interface LiveChecks { pass: number; fail: number; pending: number }
export interface LivePr {
  repo: string; number: number; title: string; url: string;
  /** The first 7 characters of the head commit. */
  head: string; mergeState: string; autoMerge: boolean; checks: LiveChecks;
  /** Ms epoch of the oldest check still running; null when nothing runs or GitHub gave no start time. */
  pendingSince: number | null;
  /** The next step the notices name for this PR; null when nothing is actionable. */
  next: string | null;
}
export interface LiveBranch { repo: string; branch: string; head: string; checks: LiveChecks; pendingSince: number | null }
export interface LiveRepo { repo: string; mode: 'open' | 'list'; prs: LivePr[]; branches: LiveBranch[]; lastError?: string }
export interface LiveState { version: 1; polledAt: number; repos: LiveRepo[] }
export interface LiveNotice { repo: string; wake: boolean; text: string; at: number; events: WatchEvent[]; subscriber?: string }

const checksOf = ({ pass, fail, pending }: Checks): LiveChecks => ({ pass, fail, pending });
const pendingSince = (c: Checks) => (c.pending > 0 ? c.pendingSince ?? null : null);

const livePr = (repo: string, s: Snapshot): LivePr => ({
  repo, number: s.number, title: s.title, url: s.url, head: s.head.slice(0, 7), mergeState: s.mergeState, autoMerge: s.auto,
  checks: checksOf(s.checks), pendingSince: pendingSince(s.checks), next: hint(s, repo) ?? null,
});
const liveBranch = (repo: string, b: BranchSnapshot): LiveBranch => ({ repo, branch: b.branch, head: b.head.slice(0, 7), checks: checksOf(b.checks), pendingSince: pendingSince(b.checks) });

/** What is followed right now, read from the stored state a poll just saved: it needs no GitHub call. */
export function liveState(state: State, polledAt: number): LiveState {
  const repos = Object.entries(state.repos).map(([repo, w]): LiveRepo => ({
    repo, mode: w.mode,
    prs: Object.values(w.snapshots).sort((a, b) => a.number - b.number).map(s => livePr(repo, s)),
    branches: Object.values(w.branches ?? {}).map(b => liveBranch(repo, b)),
    ...w.lastError ? { lastError: w.lastError } : {},
  }));
  return { version: 1, polledAt, repos };
}
