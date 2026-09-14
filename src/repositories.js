import { execFileSync } from 'node:child_process';
import { readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { countChanges } from './status.js';

function git(directory, args, raw = false) {
  const output = execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return raw ? output : output.trim();
}

async function hasGitMarker(directory) {
  try { await access(path.join(directory, '.git')); return true; }
  catch { return false; }
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
    catch { return { name: path.basename(directory), path: directory, branch, dirty: status.length > 0, lastCommit, changes }; }
    throw new Error('Unable to read the last commit');
  }
  return { name: path.basename(directory), path: directory, branch, dirty: status.length > 0, lastCommit, changes };
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
