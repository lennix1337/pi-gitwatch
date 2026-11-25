import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { GitRunner } from './autowatch.ts';

/** Simulate a merge of the exact PR commits without touching the checkout, refs, or object store of the clone. */
export async function conflictingFiles(git: GitRunner, clone: string, head: string, base: string): Promise<string[]> {
  const objects = await git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], clone);
  if (!isAbsolute(objects) || /[\r\n]/.test(objects)) return [];
  const dir = await mkdtemp(join(tmpdir(), 'gitwatch-conflict-'));
  const config = join(dir, 'no-config');
  // external: Do not inherit merge drivers or Git overrides from the user's clone or environment.
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_ATTR_NOSYSTEM: '1' };
  const scratch = (args: string[], conflict = false): Promise<string> => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: dir, env, windowsHide: true, timeout: 10_000, maxBuffer: 1 << 20 }, (error, stdout) => {
      if (!error) resolve('');
      else if (conflict && error.code === 1) resolve(stdout);
      else reject(error);
    });
  });
  try {
    await scratch(['init', '--bare', '--template=']);
    await writeFile(join(dir, 'objects', 'info', 'alternates'), `${objects}\n`);
    const output = await scratch(['-c', `core.attributesFile=${config}`, 'merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', base, head], true);
    return output.split('\0').slice(1).filter(Boolean);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
