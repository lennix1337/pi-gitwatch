import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'gitwatch-delivery-mutants-'));
const mutations = [
  ['unawaited-host', 'src/index.ts', 'await pi.sendMessage(', 'pi.sendMessage('],
  ['missing-receipt', 'src/index.ts', 'await watcher.recordDelivery(notice.wake, accepted);', '/* receipt omitted */'],
  ['rejection-counted-as-success', 'src/index.ts', '} catch { /* A rejected dispatch', '} catch { accepted = true; /* A rejected dispatch'],
];
const run = () => spawnSync(process.execPath, ['--import', 'tsx', '--test', 'test/extension.test.ts', 'test/watcher.test.ts'], {
  cwd: dir, encoding: 'utf8', timeout: 20000,
  env: { ...process.env, TEMP: join(dir, 'scratch'), TMP: join(dir, 'scratch'), TMPDIR: join(dir, 'scratch') },
});
const baseline = () => {
  const r = run();
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stdout + r.stderr);
};
try {
  cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(root, 'test'), join(dir, 'test'), { recursive: true });
  cpSync(join(root, 'package.json'), join(dir, 'package.json'));
  mkdirSync(join(dir, 'scratch'));
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  baseline();
  for (const [name, path, before, after] of mutations) {
    const file = join(dir, path), original = readFileSync(file, 'utf8');
    assert.equal(original.split(before).length, 2, `${name}: unique source anchor`);
    try {
      writeFileSync(file, original.replace(before, after));
      const r = run();
      assert.ifError(r.error);
      assert.notEqual(r.status, 0, `${name}: survived`);
      assert.match(r.stdout + r.stderr, /AssertionError|ERR_ASSERTION/, `${name}: expected an assertion failure, not a broken harness`);
      console.log(`${name}: caught`);
    } finally { writeFileSync(file, original); }
  }
  baseline();
  console.log('3 mutants caught; clean and restored copies passed; original source unchanged.');
} finally { rmSync(dir, { recursive: true, force: true }); }
