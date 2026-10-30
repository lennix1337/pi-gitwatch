import { readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ghRunner, MAX_PRS, REPO, type Runner } from './github.ts';
import { statusText, Store, Watcher, type Notice } from './watcher.ts';

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

export interface Options { run?: Runner; store?: Store; now?: () => number; schedule?: (fn: () => void, ms: number) => { unref?(): void } | unknown; cancel?: (handle: unknown) => void }

export default function extension(pi: ExtensionAPI, options: Options = {}) {
  const store = options.store ?? new Store();
  const now = options.now ?? Date.now;
  const watcher = new Watcher(store, options.run ?? ghRunner, now);
  const lease = new Lease(store.dir);
  const schedule = options.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout));
  let timer: unknown;
  let running = false;

  const deliver = (notice: Notice) => pi.sendMessage(
    { customType: MESSAGE_TYPE, content: notice.text, display: true, details: { repo: notice.repo, events: notice.events } },
    { triggerTurn: true, deliverAs: 'steer' },
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

  pi.registerTool({
    name: 'gitwatch', label: 'Watch GitHub PRs',
    description: 'Watch GitHub pull requests and get woken when they need you: checks finished or failed, merge conflict, ready to merge, review decision, merged or closed. The notice arrives as a "[gitwatch] owner/repo" message between tool calls or as a new turn; never poll or sleep for it. watch adds a repository (all open PRs, including new ones) or only "prs"; merged/closed PRs are reported once, then dropped. status (default) refreshes now and shows one line per PR with its next step. unwatch removes PRs or the repository. Read-only on GitHub: you merge, fix and push yourself.',
    parameters: Type.Object({
      action: Type.Optional(Type.Unsafe<typeof actions[number]>({ type: 'string', enum: actions, description: 'Default status.' })),
      repo: Type.Optional(Type.String({ pattern: REPO.source, description: 'owner/name; required for watch/unwatch, filters status.' })),
      prs: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, maxItems: MAX_PRS, description: 'Only these PRs; omit for every open PR.' })),
      intervalSec: Type.Optional(Type.Integer({ minimum: 10, maximum: 600, description: 'Poll interval for all watches, default 30.' })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal) {
      const action = params.action ?? 'status';
      try {
        if (!actions.includes(action)) throw new Error(`Unknown action ${action}; use status, watch or unwatch.`);
        if (params.repo !== undefined && !REPO.test(params.repo)) throw new Error('repo must be owner/name, e.g. lennix1337/Genexus18MCP.');
        if (action !== 'status' && !params.repo) throw new Error(`${action} needs repo (owner/name).`);
        if (action === 'status' && (params.prs || params.intervalSec !== undefined)) throw new Error('status accepts only repo; use watch to change PRs or the interval.');
        if (action === 'unwatch' && params.intervalSec !== undefined) throw new Error('unwatch accepts repo and prs only.');
        if (action === 'watch') {
          await watcher.watch(params.repo!, params.prs, params.intervalSec);
          start();
          return reply(statusText(watcher.state(), new Map(), params.repo, now()));
        }
        if (action === 'unwatch') {
          const removed = await watcher.unwatch(params.repo!, params.prs);
          return reply(removed ? `Stopped watching ${params.prs ? params.prs.map(n => `#${n}`).join(' ') + ' in ' : ''}${params.repo}.\n${statusText(watcher.state(), new Map(), undefined, now())}`
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
