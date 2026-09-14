import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { scanRepositories, inspectRepository } from '../src/repositories.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repo-lens-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function repository(root, name, commit = true) {
  const dir = path.join(root, name);
  await mkdir(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.name', 'Repo Lens Tests');
  git(dir, 'config', 'user.email', 'tests@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  if (commit) {
    await writeFile(path.join(dir, 'README.md'), '# Fixture\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'Initial fixture');
  }
  return dir;
}

test('reports clean and dirty repositories and ignores unrelated folders', async t => {
  const root = await fixture(t);
  await repository(root, 'clean');
  const dirty = await repository(root, 'dirty with spaces');
  await writeFile(path.join(dirty, 'new file.txt'), 'pending');
  await mkdir(path.join(root, 'ordinary'));
  const result = await scanRepositories(root);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.repositories.map(r => [r.name, r.branch, r.dirty, r.lastCommit]), [
    ['clean', 'main', false, 'Initial fixture'],
    ['dirty with spaces', 'main', true, 'Initial fixture'],
  ]);
});

test('handles an empty repository and a detached checkout', async t => {
  const root = await fixture(t);
  await repository(root, 'empty', false);
  const detached = await repository(root, 'detached');
  git(detached, 'checkout', '--detach', 'HEAD');
  const { repositories } = await scanRepositories(root);
  assert.match(repositories.find(r => r.name === 'detached').branch, /^detached:[a-f0-9]+$/);
  assert.equal(repositories.find(r => r.name === 'empty').lastCommit, null);
  assert.deepEqual(repositories.find(r => r.name === 'empty').changes,
    { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
});

test('counts tracked changes and individual untracked files with CLI output', async t => {
  const root = await fixture(t);
  const repo = await repository(root, 'counts');
  await writeFile(path.join(repo, '.gitignore'), '*.log\n');
  await writeFile(path.join(repo, 'delete.txt'), 'remove later');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Add fixtures');
  await writeFile(path.join(repo, 'README.md'), 'staged');
  git(repo, 'add', 'README.md');
  await writeFile(path.join(repo, 'README.md'), 'staged plus unstaged');
  await unlink(path.join(repo, 'delete.txt'));
  await mkdir(path.join(repo, 'new folder'));
  await writeFile(path.join(repo, 'new folder', 'one.txt'), 'new');
  await writeFile(path.join(repo, 'new folder', 'two.txt'), 'new');
  await writeFile(path.join(repo, 'ignored.log'), 'ignore');
  git(repo, 'config', 'status.showUntrackedFiles', 'no');
  const expected = { staged: 1, unstaged: 2, untracked: 2, conflicted: 0 };
  assert.deepEqual(inspectRepository(repo).changes, expected);
  const run = (...args) => spawnSync(process.execPath, [cli, root, '--dirty', '--name', 'counts', ...args], { encoding: 'utf8' });
  const json = run('--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).repositories[0].changes, expected);
  const text = run();
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /1 staged, 2 unstaged, 2 untracked/);
});

test('counts a rename once with spaces and Unicode even when rename detection is disabled in config', async t => {
  const root = await fixture(t);
  const repo = await repository(root, 'renames');
  git(repo, 'config', 'status.renames', 'false');
  git(repo, 'mv', 'README.md', 'renamed café file.md');
  assert.deepEqual(inspectRepository(repo).changes, { staged: 1, unstaged: 0, untracked: 0, conflicted: 0 });
  await writeFile(path.join(repo, 'renamed café file.md'), 'edited after rename');
  assert.deepEqual(inspectRepository(repo).changes, { staged: 1, unstaged: 1, untracked: 0, conflicted: 0 });
});

test('counts real filenames containing line breaks and tabs', { skip: process.platform === 'win32' }, async t => {
  const root = await fixture(t);
  const repo = await repository(root, 'unusual');
  git(repo, 'mv', 'README.md', 'line\nbreak\t.md');
  await writeFile(path.join(repo, 'new\nfile\t.txt'), 'new');
  assert.deepEqual(inspectRepository(repo).changes, { staged: 1, unstaged: 0, untracked: 1, conflicted: 0 });
});

test('reports real merge conflicts separately and keeps the repository dirty', async t => {
  const root = await fixture(t);
  const repo = await repository(root, 'conflict');
  git(repo, 'checkout', '-b', 'other');
  await writeFile(path.join(repo, 'README.md'), 'other\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Other change');
  git(repo, 'checkout', 'main');
  await writeFile(path.join(repo, 'README.md'), 'main\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Main change');
  assert.throws(() => git(repo, '-c', 'core.hooksPath=/dev/null', 'merge', '--no-edit', 'other'));
  const result = inspectRepository(repo);
  assert.equal(result.dirty, true);
  assert.deepEqual(result.changes, { staged: 0, unstaged: 0, untracked: 0, conflicted: 1 });
  const text = spawnSync(process.execPath, [cli, root, '--dirty'], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /0 staged, 0 unstaged, 0 untracked, 1 conflicted/);
});

test('scans the root repository and recognizes linked worktrees', async t => {
  const root = await fixture(t);
  const repo = await repository(root, 'source');
  git(repo, 'worktree', 'add', '-b', 'feature', path.join(root, 'linked'));
  assert.equal((await scanRepositories(repo)).repositories[0].name, 'source');
  const linked = (await scanRepositories(root)).repositories.find(r => r.name === 'linked');
  assert.equal(linked.branch, 'feature');
  assert.equal(linked.dirty, false);
});

test('a broken repository does not hide a valid one', async t => {
  const root = await fixture(t);
  await repository(root, 'valid');
  await mkdir(path.join(root, 'broken'));
  await writeFile(path.join(root, 'broken', '.git'), 'gitdir: missing');
  const result = await scanRepositories(root);
  assert.equal(result.repositories.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, path.join(root, 'broken'));
});

test('CLI emits JSON and meaningful exit codes', async t => {
  const root = await fixture(t);
  await repository(root, 'demo');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const success = run(root, '--json');
  assert.equal(success.status, 0);
  assert.equal(JSON.parse(success.stdout).repositories[0].name, 'demo');
  assert.equal(run('--unknown').status, 2);
  assert.equal(run(root, root).status, 2);
  const missing = run(path.join(root, 'missing'), '--json');
  assert.equal(missing.status, 1);
  assert.equal(JSON.parse(missing.stdout).errors.length, 1);
  await mkdir(path.join(root, 'broken'));
  await writeFile(path.join(root, 'broken', '.git'), 'gitdir: missing');
  const partial = run(root, '--json');
  assert.equal(partial.status, 1);
  assert.equal(JSON.parse(partial.stdout).repositories.length, 1);
  assert.equal(JSON.parse(partial.stdout).errors.length, 1);
});

test('CLI renders readable text, help and empty results', async t => {
  const root = await fixture(t);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.match(run(root).stdout, /No Git repositories found/);
  assert.match(run('--help').stdout, /Usage:/);
  await repository(root, 'demo');
  assert.match(run(root).stdout, /\[clean\] demo \(main\)/);
});

test('CLI filters local changes and combines case-insensitive name matches', async t => {
  const root = await fixture(t);
  await repository(root, 'api-clean');
  const modified = await repository(root, 'API modified');
  await writeFile(path.join(modified, 'README.md'), 'Modified tracked file');
  assert.deepEqual(inspectRepository(modified).changes, { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 });
  const staged = await repository(root, 'api-staged');
  await writeFile(path.join(staged, 'README.md'), 'Staged change');
  git(staged, 'add', '.');
  const untracked = await repository(root, 'web');
  await writeFile(path.join(untracked, 'new.txt'), 'Untracked');
  const names = (...args) => {
    const result = spawnSync(process.execPath, [cli, root, '--json', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout).repositories.map(repo => repo.name).sort();
  };
  assert.deepEqual(names('--dirty'), ['API modified', 'api-staged', 'web']);
  assert.deepEqual(names('--name', 'ApI'), ['API modified', 'api-clean', 'api-staged']);
  assert.deepEqual(names('--dirty', '--name=api'), ['API modified', 'api-staged']);
  assert.deepEqual(names('--name', 'API modified'), ['API modified']);
  assert.deepEqual(names('--name', 'missing'), []);
  const text = spawnSync(process.execPath, [cli, '--dirty', '--name', 'MODIFIED', root], { encoding: 'utf8' });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /\[changed\] API modified/);
  assert.doesNotMatch(text.stdout, /api-clean|api-staged|\bweb\b/);
});

test('CLI reports no matches without failing and documents the filters', async t => {
  const root = await fixture(t);
  await repository(root, 'clean');
  const run = (...args) => spawnSync(process.execPath, [cli, root, ...args], { encoding: 'utf8' });
  for (const args of [['--dirty'], ['--name', 'absent']]) {
    const result = run(...args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /No Git repositories match the filters/);
  }
  assert.match(run('--help').stdout, /--dirty/);
  assert.match(run('--help').stdout, /--name TEXT/);
});

test('CLI rejects missing and empty name values and invalid boolean values', () => {
  for (const args of [['--name'], ['--name', '--dirty'], ['--name='], ['--name', '   '], ['--dirty=yes']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.ok(result.stderr.trim());
    assert.equal(result.stdout, '');
  }
});

test('CLI retains scan errors even when filters exclude every successful repository', async t => {
  const root = await fixture(t);
  await repository(root, 'clean');
  await mkdir(path.join(root, 'broken'));
  await writeFile(path.join(root, 'broken', '.git'), 'gitdir: missing');
  const result = spawnSync(process.execPath, [cli, root, '--dirty', '--name', 'absent', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.repositories, []);
  assert.equal(output.errors.length, 1);
  assert.equal(output.errors[0].path, path.join(root, 'broken'));
});

test('CLI accepts a dash-prefixed directory after the option separator', async t => {
  const root = await fixture(t);
  await repository(root, '-project');
  const result = spawnSync(process.execPath, [cli, '--json', '--', '-project'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).repositories[0].name, '-project');
  const missing = spawnSync(process.execPath, [cli, '--', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /Repo Lens:/);
});
