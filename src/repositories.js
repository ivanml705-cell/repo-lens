import { execFileSync } from 'node:child_process';
import { readdir, access, stat } from 'node:fs/promises';
import path from 'node:path';
import { countChanges } from './status.js';

function git(directory, args, raw = false) {
  const output = execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  return raw ? output : output.trim();
}

async function hasGitMarker(directory) {
  try { await access(path.join(directory, '.git')); return true; }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function inspectUpstream(directory, branch, hasCommit) {
  const unavailable = status => ({ status, name: null, ahead: null, behind: null });
  if (!hasCommit) return unavailable('unborn');
  if (branch.startsWith('detached:')) return unavailable('detached');
  const [name, ref, track] = git(directory, [
    'for-each-ref', '--format=%(upstream:short)%00%(upstream)%00%(upstream:track)',
    `refs/heads/${branch}`,
  ]).split('\0');
  if (!ref) return unavailable('none');
  if (track === '[gone]') return { ...unavailable('gone'), name };
  const [ahead, behind] = git(directory, [
    'rev-list', '--left-right', '--count', `HEAD...${ref}`, '--',
  ]).split(/\s+/).map(Number);
  if (![ahead, behind].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Unable to read upstream commit counts');
  }
  return { status: 'tracked', name, ahead, behind };
}

export function inspectRepository(directory) {
  // Porcelain v1 with NUL separators handles spaces and newlines in filenames.
  const status = git(directory, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--renames'], true);
  const changes = countChanges(status);
  let branch;
  try { branch = git(directory, ['symbolic-ref', '--short', 'HEAD']); }
  catch { branch = `detached:${git(directory, ['rev-parse', '--short', 'HEAD'])}`; }
  let lastCommit = null;
  try { lastCommit = git(directory, ['log', '-1', '--format=%s']); }
  catch {
    // A newly initialized repository has no commits yet.
    try { git(directory, ['rev-parse', '--verify', 'HEAD']); }
    catch { return { name: path.basename(directory), path: directory, branch, dirty: status.length > 0, lastCommit, changes,
      upstream: inspectUpstream(directory, branch, false) }; }
    throw new Error('Unable to read the last commit');
  }
  return { name: path.basename(directory), path: directory, branch, dirty: status.length > 0, lastCommit, changes,
    upstream: inspectUpstream(directory, branch, true) };
}

export function validateScanOptions({ depth = 1, exclude = [], maxDirs = 1000 } = {}) {
  if (!Number.isInteger(depth) || depth < 0 || depth > 10) throw new Error('--depth must be an integer from 0 to 10.');
  if (!Number.isInteger(maxDirs) || maxDirs < 1 || maxDirs > 100000) throw new Error('--max-dirs must be an integer from 1 to 100000.');
  if (!Array.isArray(exclude) || exclude.some(name => typeof name !== 'string' || !name.trim() || /[/\\]/.test(name) || name === '.' || name === '..')) {
    throw new Error('--exclude requires a folder name, not a path or an empty value.');
  }
  return { depth, exclude, maxDirs };
}

export async function scanRepositories(root, options = {}) {
  const { depth, exclude, maxDirs } = validateScanOptions(options);
  const directory = path.resolve(root);
  if (!(await stat(directory)).isDirectory()) throw new Error(`Not a directory: ${directory}`);
  const excluded = new Set(['.git', ...exclude]);
  const repositories = [];
  const errors = [];
  let visited = 0;
  let stopped = false;
  async function visit(candidate, level) {
    if (stopped) return;
    if (visited >= maxDirs) {
      errors.push({ path: candidate, message: `Directory limit (${maxDirs}) reached; scan is incomplete. Use --max-dirs to increase it.` });
      stopped = true;
      return;
    }
    visited++;
    try {
      if (await hasGitMarker(candidate)) {
        try { repositories.push(inspectRepository(candidate)); }
        catch (error) { errors.push({ path: candidate, message: error.message }); }
      }
      if (level >= depth) return;
      const entries = await readdir(candidate, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        // Never follow child symlinks/junctions: they may escape the root or loop.
        if (entry.isDirectory() && !entry.isSymbolicLink() && !excluded.has(entry.name)) {
          await visit(path.join(candidate, entry.name), level + 1);
          if (stopped) break;
        }
      }
    } catch (error) {
      errors.push({ path: candidate, message: error.message });
    }
  }
  await visit(directory, 0);
  return { repositories, errors };
}
