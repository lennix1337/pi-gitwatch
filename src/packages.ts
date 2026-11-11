import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { githubRepo, type GitRunner } from './autowatch.ts';

const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');

/** A Windows drive path (`C:/x`, `C:\x`): absolute on every OS, since the settings file may name Windows folders. */
const DRIVE = /^[A-Za-z]:[\\/]/;

/** A path in one spelling: absolute, forward slashes, no trailing slash. A drive path is never joined to `base`. */
const absolute = (path: string, base: string) =>
  (DRIVE.test(path) ? win32.normalize(path) : resolve(base, path)).replace(/\\/g, '/').replace(/\/+$/, '');

/** The same, case-folded where the filesystem ignores case (Windows, drive paths): the spelling two paths are compared in. */
export const normalizePath = (path: string, platform: string = process.platform) => {
  const full = absolute(path, '/');
  return platform === 'win32' || DRIVE.test(path) ? full.toLowerCase() : full;
};

/** Sources that name a registry or URL, not a folder. */
const REGISTRY = /^(?:npm|git|jsr|github|https?|ssh):/i;

/**
 * The local folders of the Pi packages that the settings file loads (`packages`, a string or `{ source }` each).
 * Relative paths are relative to the settings folder. A missing or unreadable file loads nothing.
 */
export function loadedPackages(settingsFile = join(agentDir(), 'settings.json')): string[] {
  let parsed: { packages?: unknown };
  try { parsed = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { return []; }
  if (!Array.isArray(parsed.packages)) return [];
  const base = join(settingsFile, '..');
  return parsed.packages
    .map(p => typeof p === 'string' ? p : (p as { source?: unknown } | null)?.source)
    .filter((source): source is string => typeof source === 'string' && !REGISTRY.test(source))
    .map(source => absolute(source, base));
}

/** Whether `dir` is one of the loaded package folders. */
export const isLoadedPackage = (dir: string, packages: string[]) => packages.some(p => normalizePath(p) === normalizePath(dir));

/**
 * The folder of a loaded package whose `origin` is `repo`: where a PR that a script opened (it names no clone) would be
 * checked out. Undefined when no package is that repository.
 */
export async function packageClone(repo: string, packages: string[], git: GitRunner): Promise<string | undefined> {
  for (const dir of packages) {
    const url = await git(['remote', 'get-url', 'origin'], dir).catch(() => '');
    if (githubRepo(url)?.toLowerCase() === repo.toLowerCase()) return dir;
  }
  return undefined;
}
