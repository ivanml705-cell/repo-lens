import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { scanRepositories } from '../src/repositories.js';

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
