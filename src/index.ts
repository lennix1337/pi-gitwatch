import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createdPrs, gitRunner, pushes, resolvePush, type GitRunner } from './autowatch.ts';
import { BRANCH, ghRunner, MAX_PRS, REPO, type Runner } from './github.ts';
import { statusText, Store, Watcher, watchPush, type Notice } from './watcher.ts';

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
      if (target) followed.add(await watchPush(watcher, target.repo, target.branch));
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
  let timer: unknown;
  let running = false;

  // A notice that needs the agent wakes it; an expected merge only waits for its next turn (no model call).
  const deliver = (notice: Notice) => pi.sendMessage(
    { customType: MESSAGE_TYPE, content: notice.text, display: true, details: { repo: notice.repo, events: notice.events } },
    notice.wake ? { triggerTurn: true, deliverAs: 'steer' } : { deliverAs: 'nextTurn' },
  );

  const tick = async () => {
    timer = undefined;
    if (!running) return;
    const state = watcher.state();
    const interval = state.intervalSec * 1000;
    try {
      if (Object.keys(state.repos).length && lease.acquire(now(), interval * 3)) {
        const { notices } = await watcher.poll();
        if (running) for (const n of notices) deliver(n);
      }
    } catch { /* a failed poll is counted per repository and reported by the watcher */ }
    if (running) { timer = schedule(() => void tick(), interval); (timer as { unref?(): void })?.unref?.(); }
  };
  const start = () => { if (running) return; running = true; timer = schedule(() => void tick(), 1000); (timer as { unref?(): void })?.unref?.(); };
  const stop = () => { running = false; if (timer !== undefined) cancel(timer); timer = undefined; lease.release(); };

  pi.on('session_start', (_event, ctx) => { if (ctx.mode === 'tui') start(); });
  pi.on('session_shutdown', stop);
  // Only the polling (interactive) session follows its own pushes; a child's push is its parent's to watch.
  pi.on('tool_result', async (event, ctx) => {
    const note = running ? await noteAfterBash(event as BashResult, watcher, git, ctx.cwd) : undefined;
    return note ? { content: [...event.content, { type: 'text' as const, text: note }] } : undefined;
  });

  pi.registerTool({
    name: 'gitwatch', label: 'Watch GitHub PRs',
    description: 'Watch GitHub pull requests and branch CI and get woken when they need you: checks failed or finished (without auto-merge), merge conflict, ready to merge, auto-merge stuck, review decision, merged (an auto-merge you queued is only recorded for your next turn; add awaitMerge with prs when work waits on it) or closed. The notice arrives as a "[gitwatch] owner/repo" message between tool calls or as a new turn; never poll or sleep for it. A successful `gh pr create` or `git push` in bash is followed automatically (the output says so). watch adds a repository (all open PRs, including new ones), only "prs", or a "branch" whose latest commit\'s CI is followed until it finishes; merged/closed PRs are reported once, then dropped. status (default) refreshes now and shows one line per PR or branch with its next step. unwatch removes PRs, a branch or the repository. Read-only on GitHub: you merge, fix and push yourself.',
    parameters: Type.Object({
      action: Type.Optional(Type.Unsafe<typeof actions[number]>({ type: 'string', enum: actions, description: 'Default status.' })),
      repo: Type.Optional(Type.String({ pattern: REPO.source, description: 'owner/name; required for watch/unwatch, filters status.' })),
      prs: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: MAX_PRS, description: 'Only these PRs; omit for every open PR.' })),
      branch: Type.Optional(Type.String({ pattern: BRANCH.source, description: 'Follow the CI of this branch\'s latest commit (a direct push) until it finishes.' })),
      intervalSec: Type.Optional(Type.Integer({ minimum: 10, maximum: 600, description: 'Poll interval for all watches, default 30.' })),
      awaitMerge: Type.Optional(Type.Boolean({ description: 'With prs: wake me when they merge even under auto-merge (work waits on it).' })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const action = params.action ?? 'status';
      try {
        validate(action, params);
        validateAwait(action, params);
        if (action === 'watch') {
          await watcher.watch(params.repo!, { prs: params.prs, branch: params.branch, intervalSec: params.intervalSec, awaitMerge: params.awaitMerge });
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
        const { events } = Object.keys(before.repos).length ? await watcher.poll(params.repo, signal) : { events: new Map() };
        return reply(statusText(watcher.state(), events, params.repo, now()));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `gitwatch ${action} failed: ${message}\nNothing on GitHub was changed. Current watches: gitwatch {"action":"status"}` }], details: { error: message }, isError: true };
      }
    },
  });
}

const reply = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });

interface Params { action?: string; repo?: string; prs?: number[]; branch?: string; intervalSec?: number; awaitMerge?: boolean }

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

function validateAwait(action: string, params: Params) {
  if (params.awaitMerge !== undefined && (action !== 'watch' || !params.prs)) throw new Error('awaitMerge goes with watch and prs: the PRs whose merge you wait on.');
}

interface BashResult { toolName: string; isError: boolean; input: Record<string, unknown>; content: ({ type: 'text'; text: string } | { type: 'image' })[] }

/** The note `autoWatch` appends to a successful bash command that pushed or created a PR, or undefined. */
export async function noteAfterBash(event: BashResult, watcher: Watcher, git: GitRunner, cwd: string): Promise<string | undefined> {
  if (event.toolName !== 'bash' || event.isError) return undefined;
  const command = typeof event.input.command === 'string' ? event.input.command : '';
  if (!PUSH_OR_PR.test(command)) return undefined;
  const output = event.content.flatMap(c => c.type === 'text' ? [c.text] : []).join('\n');
  return autoWatch(watcher, git, command, output, cwd);
}
