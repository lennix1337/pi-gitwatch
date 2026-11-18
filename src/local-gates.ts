import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The command that validates a repository locally when GitHub never started its jobs, from `local-gates.json` in the
 * gitwatch state folder: `{ "owner/repo": "node ~/bin/ship.mjs {pr}" }`. `{pr}` and `{head}` are filled in; a branch
 * notice has no PR, so a command that needs one is skipped there. Read at each use, so an edit applies at once.
 */
export function localGate(repo: string, head: string, pr?: number, dir = process.env.PI_GITWATCH_DIR ?? join(homedir(), '.pi', 'agent', 'gitwatch')): string | undefined {
  let gates: unknown;
  try { gates = JSON.parse(readFileSync(join(dir, 'local-gates.json'), 'utf8')); } catch { return undefined; }
  const command = (gates as Record<string, unknown> | null)?.[repo];
  if (typeof command !== 'string' || !command.trim()) return undefined;
  if (command.includes('{pr}') && pr === undefined) return undefined;
  return command.replaceAll('{pr}', String(pr)).replaceAll('{head}', head);
}
