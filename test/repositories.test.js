import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, unlink, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { scanRepositories, inspectRepository } from '../src/repositories.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('version flags read package metadata without scanning the requested directory', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const flag of ['--version', '-v']) {
    const result = spawnSync(process.execPath, [cli, 'nonexistent-folder', flag], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `repo-lens ${version}`);
    assert.equal(result.stderr, '');
  }
});

test('text output identifies same-name repositories and summarizes only displayed results', async t => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'one'));
  await mkdir(path.join(root, 'two'));
  const clean = await repository(path.join(root, 'one'), 'app');
  const dirty = await repository(path.join(root, 'two'), 'app');
  await writeFile(path.join(dirty, 'new.txt'), 'new');
  const run = (...args) => spawnSync(process.execPath, [cli, root, '--depth', '2', ...args], { encoding: 'utf8' });
  const text = run();
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes(`Path: ${clean}`));
  assert.ok(text.stdout.includes(`Path: ${dirty}`));
  assert.match(text.stdout, /Shown: 2 repositories \(1 changed, 1 clean\); 0 scan errors/);
  const filtered = run('--dirty');
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.match(filtered.stdout, /Shown: 1 repository \(1 changed, 0 clean\)/);
  assert.ok(!filtered.stdout.includes(`Path: ${clean}`));
  assert.deepEqual(Object.keys(JSON.parse(run('--json').stdout)), ['repositories', 'errors']);
  const limited = run('--max-dirs', '1');
  assert.equal(limited.status, 1);
  assert.match(limited.stdout, /Scan incomplete/);
  assert.match(limited.stderr, /Directory limit/);
});

test('upstream lookup handles branch and tag names that collide', async t => {
  const root = await fixture(t);
  const repo = await repository(root, 'collision');
  git(repo, 'branch', 'base');
  git(repo, 'branch', '--set-upstream-to=base', 'main');
  git(repo, 'tag', 'main');
  const result = inspectRepository(repo);
  assert.equal(result.branch, 'main');
  assert.deepEqual(result.upstream, { status: 'tracked', name: 'base', ahead: 0, behind: 0 });
});

test('scan depth includes the root, respects boundaries and discovers nested repositories', async t => {
  const root = await fixture(t);
  const parent = await repository(root, 'parent', false);
  await repository(parent, 'child', false);
  const nested = path.join(parent, 'group');
  await mkdir(nested);
  await repository(nested, 'grandchild', false);
  const names = async options => (await scanRepositories(parent, options)).repositories.map(repo => repo.name);
  assert.deepEqual(await names({ depth: 0 }), ['parent']);
  assert.deepEqual(await names(), ['parent', 'child']);
  assert.deepEqual(await names({ depth: 2 }), ['parent', 'child', 'grandchild']);
  const missing = path.join(root, 'missing');
  await assert.rejects(scanRepositories(missing, { depth: 0 }));
  const file = path.join(root, 'file');
  await writeFile(file, 'file');
  await assert.rejects(scanRepositories(file, { depth: 0 }), /Not a directory/);
});

test('exclusions prune whole subtrees by literal folder name, including repeated CLI flags', async t => {
  const root = await fixture(t);
  for (const folder of ['vendor', 'archive', 'keep', '.git']) {
    await mkdir(path.join(root, folder));
    await repository(path.join(root, folder), 'project', false);
  }
  // A .git directory on the root is intentionally invalid; exclude it from traversal.
  const result = await scanRepositories(root, { depth: 2, exclude: ['vendor', 'archive'] });
  assert.deepEqual(result.repositories.map(repo => repo.path), [path.join(root, 'keep', 'project')]);
  assert.equal(result.errors.length, 1);
  const cliResult = spawnSync(process.execPath, [cli, root, '--depth=2', '--exclude', 'vendor', '--exclude=archive', '--json'], { encoding: 'utf8' });
  assert.equal(cliResult.status, 1);
  assert.deepEqual(JSON.parse(cliResult.stdout).repositories.map(repo => repo.path), [path.join(root, 'keep', 'project')]);
  const explicitRoot = await scanRepositories(path.join(root, 'keep', 'project'), { depth: 0, exclude: ['project'] });
  assert.equal(explicitRoot.repositories.length, 1);
});

test('directory budget returns partial results and a single explicit error', async t => {
  const root = await fixture(t);
  await repository(root, 'a', false);
  await repository(root, 'b', false);
  const result = await scanRepositories(root, { depth: 1, maxDirs: 2 });
  assert.deepEqual(result.repositories.map(repo => repo.name), ['a']);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /scan is incomplete/);
  assert.equal((await scanRepositories(root, { maxDirs: 3 })).errors.length, 0);
  assert.equal((await scanRepositories(root, { maxDirs: 2, exclude: ['b'] })).errors.length, 0);
  const cliResult = spawnSync(process.execPath, [cli, root, '--max-dirs', '2', '--json'], { encoding: 'utf8' });
  assert.equal(cliResult.status, 1);
  assert.equal(JSON.parse(cliResult.stdout).repositories.length, 1);
});

test('discovery skips child directory links and cycles', async t => {
  const root = await fixture(t);
  const scanRoot = path.join(root, 'scan');
  await mkdir(scanRoot);
  const outside = await repository(root, 'outside', false);
  await repository(scanRoot, 'inside', false);
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(outside, path.join(scanRoot, 'external-link'), type);
  await symlink(scanRoot, path.join(scanRoot, 'loop'), type);
  const result = await scanRepositories(scanRoot, { depth: 10, maxDirs: 2 });
  assert.deepEqual(result.repositories.map(repo => repo.name), ['inside']);
  assert.deepEqual(result.errors, []);
});

test('CLI validates traversal options before scanning', async t => {
  const root = await fixture(t);
  for (const args of [
    ['--depth', '11'], ['--depth=-1'], ['--depth', '1.5'], ['--depth='], ['--depth', '1e1'],
    ['--max-dirs', '0'], ['--max-dirs', '100001'], ['--max-dirs', 'Infinity'],
    ['--exclude='], ['--exclude', '   '], ['--exclude', 'a/b'], ['--exclude', 'a\\b'], ['--exclude', '..'],
  ]) {
    const result = spawnSync(process.execPath, [cli, root, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.ok(result.stderr.trim());
  }
  const repo = await repository(root, 'project', false);
  const success = spawnSync(process.execPath, [cli, root, '--depth', '1', '--name', 'project', '--json'], { encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).repositories[0].path, repo);
  await assert.rejects(scanRepositories(root, { depth: 100 }), /--depth/);
  await assert.rejects(scanRepositories(root, { exclude: 'vendor' }), /--exclude/);
});
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
  assert.deepEqual(repositories.find(r => r.name === 'empty').upstream,
    { status: 'unborn', name: null, ahead: null, behind: null });
  assert.deepEqual(repositories.find(r => r.name === 'detached').upstream,
    { status: 'detached', name: null, ahead: null, behind: null });
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
  assert.equal(linked.upstream.status, 'none');
});

test('reports synced, ahead, behind and diverged upstreams using local refs only', async t => {
  const root = await fixture(t);
  const repo = await repository(root, 'tracked');
  // Deliberately inaccessible remote: all information must come from local refs.
  git(repo, 'remote', 'add', 'origin', path.join(root, 'nonexistent-remote'));
  git(repo, 'config', 'branch.main.remote', 'origin');
  git(repo, 'config', 'branch.main.merge', 'refs/heads/main');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const expected = (ahead, behind) => ({ status: 'tracked', name: 'origin/main', ahead, behind });
  assert.deepEqual(inspectRepository(repo).upstream, expected(0, 0));
  git(repo, 'checkout', '-b', 'remote-side');
  git(repo, 'commit', '--allow-empty', '-m', 'Remote one');
  git(repo, 'commit', '--allow-empty', '-m', 'Remote two');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'checkout', 'main');
  assert.deepEqual(inspectRepository(repo).upstream, expected(0, 2));
  git(repo, 'commit', '--allow-empty', '-m', 'Local one');
  assert.deepEqual(inspectRepository(repo).upstream, expected(1, 2));
  const run = (...args) => spawnSync(process.execPath, [cli, root, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_ALLOW_PROTOCOL: '' },
  });
  const json = run('--name', 'tracked', '--json');
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).repositories[0].upstream, expected(1, 2));
  assert.match(run().stdout, /origin\/main: 1 ahead, 2 behind \(local refs\)/);
  assert.deepEqual(JSON.parse(run('--dirty', '--json').stdout).repositories, []);
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'commit', '--allow-empty', '-m', 'Local two');
  assert.deepEqual(inspectRepository(repo).upstream, expected(1, 0));
});

test('distinguishes absent and gone upstreams without failing the scan', async t => {
  const root = await fixture(t);
  const repo = await repository(root, 'gone');
  assert.deepEqual(inspectRepository(repo).upstream,
    { status: 'none', name: null, ahead: null, behind: null });
  git(repo, 'remote', 'add', 'origin', path.join(root, 'missing'));
  git(repo, 'config', 'branch.main.remote', 'origin');
  git(repo, 'config', 'branch.main.merge', 'refs/heads/main');
  const result = await scanRepositories(root);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.repositories[0].upstream,
    { status: 'gone', name: 'origin/main', ahead: null, behind: null });
  const text = spawnSync(process.execPath, [cli, root], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Upstream origin\/main unavailable locally/);
});

test('supports a local upstream and linked worktrees', async t => {
  const root = await fixture(t);
  const repo = await repository(root, 'source');
  git(repo, 'branch', 'base');
  git(repo, 'branch', '--set-upstream-to=base', 'main');
  assert.deepEqual(inspectRepository(repo).upstream,
    { status: 'tracked', name: 'base', ahead: 0, behind: 0 });
  const linked = path.join(root, 'linked');
  git(repo, 'worktree', 'add', '-b', 'feature/topic', linked);
  git(linked, 'branch', '--set-upstream-to=main');
  git(linked, 'commit', '--allow-empty', '-m', 'Worktree change');
  assert.deepEqual(inspectRepository(linked).upstream,
    { status: 'tracked', name: 'main', ahead: 1, behind: 0 });
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
