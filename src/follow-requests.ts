import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './github.ts';

/**
 * PRs another process asks the poller to follow, one JSON file each in `<state dir>/follow/`. A script that opens a PR
 * in its own process (pi-optchat's ship.mjs), or a command moved to a background shell, never reaches `tool_result`
 * with the PR URL, so its PR was never followed and its merge woke nobody (03/11: #91, #92, #94).
 */
export interface FollowRequest { repo: string; pr: number }

const folder = (dir: string) => join(dir, 'follow');

/** Drops a request for the poller; safe from any process (written to a temp name, then renamed). */
export function requestFollow(dir: string, request: FollowRequest) {
  mkdirSync(folder(dir), { recursive: true });
  const name = `${request.repo.replace('/', '__')}#${request.pr}`;
  const tmp = join(folder(dir), `${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(request));
  renameSync(tmp, join(folder(dir), `${name}.json`));
}

/** Requests waiting in the folder; a malformed file is removed so it cannot block the others. */
export function pendingFollows(dir: string): { request: FollowRequest; done: () => void }[] {
  let names: string[];
  try { names = readdirSync(folder(dir)).filter(n => n.endsWith('.json')); } catch { return []; }
  const found: { request: FollowRequest; done: () => void }[] = [];
  for (const name of names) {
    const file = join(folder(dir), name);
    const done = () => rmSync(file, { force: true });
    try {
      const r = JSON.parse(readFileSync(file, 'utf8')) as Partial<FollowRequest>;
      if (typeof r.repo === 'string' && REPO.test(r.repo) && Number.isInteger(r.pr) && r.pr! > 0) found.push({ request: { repo: r.repo, pr: r.pr! }, done });
      else done();
    } catch { done(); }
  }
  return found;
}
