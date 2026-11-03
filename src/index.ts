import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createdPrs, githubRepo, gitRunner, ownMerges, pushes, resolvePush, type GitRunner } from './autowatch.ts';
import { cleanupLines } from './cleanup.ts';
import { pendingFollows } from './follow-requests.ts';
import { BRANCH, ghRunner, MAX_PRS, REPO, type Runner } from './github.ts';
import { statusText, Store, Watcher, watchPush, type Notice } from './watcher.ts';
import { SUBSCRIBER, SUBSCRIBER_NOTICE_CHANNEL, type SubscriberNotice } from './subscribers.ts';

export const MESSAGE_TYPE = 'gitwatch';
const actions = ['status', 'watch', 'unwatch'] as const;

/** One poller per machine: the interactive Pi holding a fresh lease. Subagents and one-shot runs never poll. */
export class Lease {
  constructor(readonly dir: string, readonly pid = process.pid) {}
  private get file() { return join(this.dir, 'lease.json'); }
  acquire(now: number, staleMs: number): boolean {
    try {
      const held = JSON.parse(readFileSync(this.file, 'utf8')) as { pid: number; at: number };
      if (held.pid !== this.pid && now - held.at < staleMs && alive(held.pid)) return false;
    } catch { /* no lease yet */ }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify({ pid: this.pid, at: now }));
    return true;
  }
  release() {
    try { if ((JSON.parse(readFileSync(this.file, 'utf8')) as { pid: number }).pid === this.pid) rmSync(this.file); } catch { /* already gone */ }
  }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

/** The poll loop: `waiting` for the next tick, `polling` inside one, `stopped` when the session is not following. */
type Loop = { phase: 'stopped' } | { phase: 'waiting'; timer: unknown } | { phase: 'polling' };
const LOOP_MOVES: Record<Loop['phase'], Loop['phase'][]> = { stopped: ['waiting', 'stopped'], waiting: ['polling', 'stopped'], polling: ['waiting', 'stopped'] };

export interface Options {
  run?: Runner; git?: GitRunner; store?: Store; now?: () => number;
  schedule?: (fn: () => void, ms: number) => { unref?(): void } | unknown; cancel?: (handle: unknown) => void;
}

/** Commands worth inspecting after they ran: a push or a PR creation. */
const PUSH_OR_PR = /\bgit\b[^\n]*\bpush\b|\bgh\s+pr\s+create\b/;

/**
 * Starts following what a successful shell command just published: PRs from `gh pr create`, and for each `git push`
 * the branch's open PR or, without one, the CI of the pushed commit. Returns the note appended to the command output.
 */
export async function autoWatch(watcher: Watcher, git: GitRunner, command: string, output: string, cwd: string): Promise<string | undefined> {
  const followed = new Set<string>(), failed: string[] = [];
  for (const { repo, pr } of createdPrs(command, output)) {
    try { await watcher.watch(repo, { prs: [pr] }); followed.add(`${repo} #${pr}`); } catch (e) { failed.push(`${repo} #${pr}: ${(e as Error).message}`); }
  }
  for (const push of pushes(command, cwd)) {
    try {
      const target = await resolvePush(push, git);
      if (target) followed.add(await watchPush(watcher, target.repo, target.branch, target.clone));
    } catch (e) { failed.push(`push in ${push.dir}: ${(e as Error).message.split('\n')[0]}`); }
  }
  const lines = [];
  if (followed.size) lines.push(`[gitwatch] now following ${[...followed].join(', ')}: you are woken when CI finishes or fails, on conflicts and merges; do not poll gh.`);
  if (failed.length) lines.push(`[gitwatch] could not start following ${failed.join('; ')}. Watch by hand: gitwatch {"action":"watch","repo":"owner/name"}`);
  return lines.length ? lines.join('\n') : undefined;
}

export default function extension(pi: ExtensionAPI, options: Options = {}) {
  const store = options.store ?? new Store();
  const now = options.now ?? Date.now;
  const watcher = new Watcher(store, options.run ?? ghRunner, now);
  const git = options.git ?? gitRunner;
  const lease = new Lease(store.dir);
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  let loop: Loop = { phase: 'stopped' };
  /** Changes on every stop, so a tick that began before it can neither deliver afterwards nor schedule a second loop. */
  let epoch = 0;
  let interactive = false;
  let warn: ((text: string) => void) | undefined;
  let illegalMoveReported = false;

  /** The only place `loop` changes: a move the table does not list is ignored and reported once. */
  const move = (next: Loop): boolean => {
    if (!LOOP_MOVES[loop.phase].includes(next.phase)) {
      if (!illegalMoveReported) { illegalMoveReported = true; warn?.(`Gitwatch: ignored an impossible poll loop move ${loop.phase} -> ${next.phase}.`); }
      return false;
    }
    loop = next;
    return true;
  };
  const wait = (ms: number, mine: number) => {
    const timer = schedule(() => tick(mine), ms);
    (timer as { unref?(): void })?.unref?.();
    move({ phase: 'waiting', timer });
  };

  /** Local cleanup of merged PRs: its lines are reported with the merge, in the same poll. */
  const cleanup = (notice: { clone: string; events: Notice['events'] }) => cleanupLines(git, notice);

  /**
   * A notice of a subscriber goes on the event bus first; a consumer that accepts it owns it. Otherwise (no consumer, or
   * none accepted) it is handed back to this session, which is the default route.
   */
  const claimForSubscriber = (label: string, notice: Notice): boolean => {
    const claim: SubscriberNotice = { subscriber: label, repo: notice.repo, wake: notice.wake, text: notice.text, events: notice.events, accepted: false, accept() { claim.accepted = true; } };
    try { pi.events.emit(SUBSCRIBER_NOTICE_CHANNEL, claim); }
    catch (error) { warn?.(`Gitwatch: subscriber ${label} failed while taking a notice (${error instanceof Error ? error.message : String(error)}); the notice stays here.`); }
    return claim.accepted;
  };

  // A notice that needs the agent wakes it; an expected merge only waits for its next turn (no model call).
  const deliver = async (notice: Notice) => {
    if (notice.subscriber) {
      const claimed = claimForSubscriber(notice.subscriber, notice);
      await watcher.recordSubscriber(claimed);
      if (claimed) return;
    }
    const text = notice.subscriber ? `${notice.text}\n(For ${notice.subscriber}: no subscriber accepted it, so it is delivered here.)` : notice.text;
    let accepted = false;
    try {
      await pi.sendMessage(
        { customType: MESSAGE_TYPE, content: text, display: true, details: { repo: notice.repo, events: notice.events } },
        notice.wake ? { triggerTurn: true, deliverAs: 'steer' } : { deliverAs: 'nextTurn' },
      );
      accepted = true;
    } catch { /* A rejected dispatch may have taken effect; record uncertainty without replaying it. */ }
    await watcher.recordDelivery(notice.wake, accepted);
    if (!accepted) warn?.('Gitwatch: notice delivery is uncertain. Inspect session activity before retrying; no automatic replay.');
  };

  const tick = async (mine: number) => {
    if (mine !== epoch || loop.phase !== 'waiting' || !move({ phase: 'polling' })) return;
    const state = watcher.state();
    const interval = state.intervalSec * 1000;
    try {
      const follows = pendingFollows(store.dir);
      if ((Object.keys(state.repos).length || follows.length) && lease.acquire(now(), interval * 3)) {
        for (const { request, done } of follows) {
          try { await watcher.watch(request.repo, { prs: [request.pr] }); done(); }
          catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // A PR that is gone or already ended has nothing to follow; anything else (network) is retried next poll.
            if (/^Not found|already merged or closed/.test(message)) done();
            warn?.(`Gitwatch: could not follow ${request.repo} #${request.pr} asked by another process (${message.split('\n')[0]}).`);
          }
        }
        const { notices } = await watcher.poll(undefined, undefined, { cleanup });
        for (const n of notices) { if (mine !== epoch) break; await deliver(n); }
      }
    } catch { warn?.('Gitwatch: polling or local delivery evidence could not be completed. Inspect gitwatch status and local state before retrying.'); }
    if (mine === epoch) wait(interval, mine);
  };
  /** Only an interactive session polls; a tool call in a subagent or one-shot run records the watch for the poller. */
  const start = () => { if (interactive && loop.phase === 'stopped') wait(1000, epoch); };
  const stop = () => {
    epoch++;
    if (loop.phase === 'waiting') cancel(loop.timer);
    move({ phase: 'stopped' });
    lease.release();
  };

  pi.on('session_start', (_event, ctx) => {
    warn = ctx.hasUI ? text => ctx.ui.notify(text, 'warning') : undefined;
    interactive = ctx.mode === 'tui';
    start();
  });
  pi.on('session_shutdown', stop);
  // Only the polling (interactive) session follows its own pushes and merges; a child's push or merge is its parent's to watch.
  pi.on('tool_result', async (event, ctx) => {
    if (loop.phase !== 'stopped') {
      try { await noteOwnMerges(event as BashResult, watcher, git, ctx.cwd); }
      catch (error) { warn?.(`Gitwatch: could not record a merge made here (${error instanceof Error ? error.message : String(error)}); its notice may still wake the agent.`); }
    }
    const note = loop.phase !== 'stopped' ? await noteAfterBash(event as BashResult, watcher, git, ctx.cwd) : undefined;
    return note ? { content: [...event.content, { type: 'text' as const, text: note }] } : undefined;
  });

  pi.registerTool({
    name: 'gitwatch', label: 'Watch GitHub PRs',
    description: 'Watch GitHub pull requests and branch CI and get woken when they need you: checks failed or finished (without auto-merge), merge conflict, ready to merge, auto-merge stuck, review decision, merged (auto-merge included) or closed. The notice arrives as a "[gitwatch] owner/repo" message between tool calls or as a new turn; never poll or sleep for it. A successful `gh pr create` or `git push` in bash is followed automatically (the output says so). watch adds a repository (all open PRs, including new ones), only "prs", or a "branch" whose latest commit\'s CI is followed until it finishes; merged/closed PRs are reported once, then dropped. status (default) refreshes now and shows one line per PR or branch with its next step. unwatch removes PRs, a branch or the repository. Read-only on GitHub: you merge, fix and push yourself.',
    parameters: Type.Object({
      action: Type.Optional(Type.Unsafe<typeof actions[number]>({ type: 'string', enum: actions, description: 'Default status.' })),
      repo: Type.Optional(Type.String({ pattern: REPO.source, description: 'owner/name; required for watch/unwatch, filters status.' })),
      prs: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: MAX_PRS, description: 'Only these PRs; omit for every open PR.' })),
      branch: Type.Optional(Type.String({ pattern: BRANCH.source, description: 'Follow the CI of this branch\'s latest commit (a direct push) until it finishes.' })),
      intervalSec: Type.Optional(Type.Integer({ minimum: 10, maximum: 600, description: 'Poll interval for all watches, default 30.' })),
      subscriber: Type.Optional(Type.String({ pattern: SUBSCRIBER.source, description: 'With prs or branch: the notices of those go to this subscriber label (a subagent) when it takes them; if none does, they come here. Unwatch and watch again to return them here.' })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const action = params.action ?? 'status';
      try {
        validate(action, params);
        validateSubscriber(action, params);
        if (action === 'watch') {
          await watcher.watch(params.repo!, { prs: params.prs, branch: params.branch, intervalSec: params.intervalSec, subscriber: params.subscriber });
          start();
          return reply(statusText(watcher.state(), new Map(), params.repo, now()));
        }
        if (action === 'unwatch') {
          const removed = await watcher.unwatch(params.repo!, params.prs, params.branch);
          const what = params.branch ? `${params.branch} CI in ` : params.prs ? `${params.prs.map(n => `#${n}`).join(' ')} in ` : '';
          return reply(removed ? `Stopped watching ${what}${params.repo}.\n${statusText(watcher.state(), new Map(), undefined, now())}`
            : `${params.repo} was not watched; nothing changed.`);
        }
        const before = watcher.state();
        if (params.repo && !before.repos[params.repo]) return reply(statusText(before, new Map(), params.repo, now()));
        // Changes found by this refresh are shown here, so they are not announced again.
        const { events } = Object.keys(before.repos).length ? await watcher.poll(params.repo, signal, { deliver: false, cleanup }) : { events: new Map() };
        return reply(statusText(watcher.state(), events, params.repo, now()));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `gitwatch ${action} failed: ${message}\nNothing on GitHub was changed. Current watches: gitwatch {"action":"status"}` }], details: { error: message }, isError: true };
      }
    },
  });
}

const reply = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });

interface Params { action?: string; repo?: string; prs?: number[]; branch?: string; intervalSec?: number; subscriber?: string }

/** Rejects a call before any GitHub request, with the corrective hint. */
function validate(action: string, params: Params) {
  if (!(actions as readonly string[]).includes(action)) throw new Error(`Unknown action ${action}; use status, watch or unwatch.`);
  if (params.repo !== undefined && !REPO.test(params.repo)) throw new Error('repo must be owner/name, e.g. lennix1337/Genexus18MCP.');
  if (action !== 'status' && !params.repo) throw new Error(`${action} needs repo (owner/name).`);
  if (action === 'status' && (params.prs || params.branch !== undefined || params.intervalSec !== undefined)) throw new Error('status accepts only repo; use watch to change PRs or the interval.');
  if (action === 'unwatch' && params.intervalSec !== undefined) throw new Error('unwatch accepts repo, prs or branch only.');
  if (params.branch !== undefined && !BRANCH.test(params.branch)) throw new Error('branch must be a branch name such as main or feat/x.');
  if (params.branch !== undefined && params.prs) throw new Error('pass prs or branch, not both.');
}

function validateSubscriber(action: string, params: Params) {
  if (params.subscriber === undefined) return;
  if (action !== 'watch' || (!params.prs && params.branch === undefined)) throw new Error('subscriber goes with watch and prs or branch: the PRs or branch whose notices that subscriber takes.');
  if (!SUBSCRIBER.test(params.subscriber)) throw new Error('subscriber must be up to 64 letters, digits, dots, colons, underscores or dashes.');
}

interface BashResult { toolName: string; isError: boolean; input: Record<string, unknown>; content: ({ type: 'text'; text: string } | { type: 'image' })[] }

/**
 * Records the PRs a successful bash command merged with `gh pr merge` (not `--auto`) in the repository it names, or in the
 * clone it ran in, when that repository is watched.
 */
export async function noteOwnMerges(event: BashResult, watcher: Watcher, git: GitRunner, cwd: string): Promise<void> {
  if (event.toolName !== 'bash' || event.isError) return;
  const command = typeof event.input.command === 'string' ? event.input.command : '';
  if (!/\bgh\s+pr\s+merge\b/.test(command)) return;
  for (const merge of ownMerges(command, cwd)) {
    // A clone without an origin remote names no GitHub repository: there is nothing to record.
    const repo = merge.repo ?? githubRepo(await git(['remote', 'get-url', 'origin'], merge.dir).catch(() => ''));
    if (repo) await watcher.noteOwnMerge(repo, merge.pr);
  }
}

/** The note `autoWatch` appends to a successful bash command that pushed or created a PR, or undefined. */
export async function noteAfterBash(event: BashResult, watcher: Watcher, git: GitRunner, cwd: string): Promise<string | undefined> {
  if (event.toolName !== 'bash' || event.isError) return undefined;
  const command = typeof event.input.command === 'string' ? event.input.command : '';
  if (!PUSH_OR_PR.test(command)) return undefined;
  const output = event.content.flatMap(c => c.type === 'text' ? [c.text] : []).join('\n');
  return autoWatch(watcher, git, command, output, cwd);
}
