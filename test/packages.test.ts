import assert from 'node:assert/strict';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isLoadedPackage, loadedPackages, normalizePath, packageClone } from '../src/packages.ts';
import { tempDir } from './fixtures.ts';

const settings = (packages: unknown) => {
  const dir = tempDir();
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ theme: 'dark', packages }));
  return { dir, file };
};

test('loaded packages are the local folders of `packages`: strings or { source }, registry sources skipped, relative paths from the settings folder', () => {
  const { dir, file } = settings(['C:/projetos/pi-optchat', { source: 'C:\\projetos\\pi-ripwire' }, 'npm:@scope/pkg', 'git:github.com/o/r', { source: 'https://example.com/x' }, '../sibling', 42, null]);
  const found = loadedPackages(file).map(p => normalizePath(p));
  assert.deepEqual(found.slice(0, 2), [normalizePath('C:/projetos/pi-optchat'), normalizePath('C:/projetos/pi-ripwire')]);
  assert.equal(found[0], 'c:/projetos/pi-optchat', 'a drive path is absolute on every OS, not joined to the settings folder');
  assert.equal(found.length, 3);
  assert.equal(found[2], normalizePath(join(dir, '..', 'sibling')));
});

test('a missing, malformed or package-less settings file loads nothing', () => {
  assert.deepEqual(loadedPackages(join(tempDir(), 'none.json')), []);
  const bad = join(tempDir(), 'settings.json');
  writeFileSync(bad, '{ not json');
  assert.deepEqual(loadedPackages(bad), []);
  assert.deepEqual(loadedPackages(settings('not a list').file), []);
});

test('paths are compared normalized: slashes, trailing slash and, on Windows, case', () => {
  assert.equal(normalizePath('C:\\Projetos\\pi-optchat\\', 'win32'), normalizePath('c:/projetos/pi-optchat', 'win32'));
  assert.notEqual(normalizePath('/a/B', 'linux'), normalizePath('/a/b', 'linux'), 'POSIX paths are case-sensitive');
  assert.equal(normalizePath('C:\\Projetos\\pi-optchat\\', 'linux'), normalizePath('c:/projetos/pi-optchat', 'linux'), 'a drive path is a Windows path on any OS');
  assert.equal(normalizePath('C:/projetos/pi-optchat', 'linux'), 'c:/projetos/pi-optchat', 'and is never joined to a base folder');
  assert.equal(isLoadedPackage('/x/y/', ['/x/y']), true);
  assert.equal(isLoadedPackage('C:/projetos/other', ['C:/projetos/pi-optchat']), false);
});

test('the clone for a repository is the loaded package whose origin is that repository', async () => {
  const origins: Record<string, string> = { '/p/a': 'git@github.com:o/a.git', '/p/b': 'https://github.com/O/B.git', '/p/c': '' };
  const git = async (args: string[], cwd: string) => { if (!origins[cwd]) throw new Error('no remote'); return origins[cwd]; };
  const packages = ['/p/c', '/p/a', '/p/b'];
  assert.equal(await packageClone('o/b', packages, git), '/p/b', 'case-insensitive, https or ssh');
  assert.equal(await packageClone('o/a', packages, git), '/p/a');
  assert.equal(await packageClone('o/zzz', packages, git), undefined);
});

/** A real folder and a second spelling of it (a junction on Windows, a symlink elsewhere): what 8.3 short names or a linked temp dir look like to a string comparison. */
function twoSpellings() {
  const root = tempDir();
  const real = join(root, 'real-folder-with-a-long-name');
  const alias = join(root, 'ALIAS');
  mkdirSync(join(real, 'pkg'), { recursive: true });
  symlinkSync(real, alias, 'junction');
  return { real, alias, pkg: join(real, 'pkg'), aliased: join(alias, 'pkg') };
}

test('two spellings of one existing folder (short 8.3 name, junction, symlink) compare equal', () => {
  const { pkg, aliased } = twoSpellings();
  assert.notEqual(pkg.toLowerCase(), aliased.toLowerCase(), 'the spellings differ as strings');
  assert.equal(normalizePath(aliased), normalizePath(pkg));
  assert.equal(normalizePath(`${aliased}/`), normalizePath(pkg));
  assert.equal(isLoadedPackage(aliased, [pkg]), true);
  assert.equal(isLoadedPackage(pkg, [aliased]), true);
  assert.equal(normalizePath(pkg), normalizePath(realpathSync.native(pkg)));
});

test('a folder that does not exist is compared by its plain normalized spelling', () => {
  const { alias } = twoSpellings();
  assert.equal(normalizePath(join(alias, 'missing')), normalizePath(join(alias, 'missing/')));
  assert.equal(isLoadedPackage(join(alias, 'missing'), [join(alias, 'other')]), false);
});
