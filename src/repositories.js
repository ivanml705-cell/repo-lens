import { execFileSync } from 'node:child_process';
import { readdir, access } from 'node:fs/promises';
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
  catch { return false; }
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

export async function scanRepositories(root) {
  const directory = path.resolve(root);
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = [];
  if (await hasGitMarker(directory)) candidates.push(directory);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && entry.name !== '.git') {
      const child = path.join(directory, entry.name);
      if (await hasGitMarker(child)) candidates.push(child);
    }
  }
  const repositories = [];
  const errors = [];
  for (const candidate of candidates) {
    try { repositories.push(inspectRepository(candidate)); }
    catch (error) { errors.push({ path: candidate, message: error.message }); }
  }
  return { repositories, errors };
}
