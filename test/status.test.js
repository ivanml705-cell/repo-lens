import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countChanges } from '../src/status.js';

test('preserves leading status spaces and counts overlapping changes', () => {
  assert.deepEqual(countChanges(' M first\0MM second\0A  third\0 D fourth\0?? new\0!! ignored\0'),
    { staged: 2, unstaged: 3, untracked: 1, conflicted: 0 });
  assert.deepEqual(countChanges(''), { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
});

test('rename/copy source names are not parsed as statuses, including control characters', () => {
  assert.deepEqual(countChanges('RM new\nname\0?? old\tname\0C  copy\0MM source\0 R target\0UU source\0?? space name \0'),
    { staged: 2, unstaged: 2, untracked: 1, conflicted: 0 });
});

test('all unmerged states count as conflicts rather than prepared changes', () => {
  const status = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].map(code => `${code} file\0`).join('');
  assert.deepEqual(countChanges(status), { staged: 0, unstaged: 0, untracked: 0, conflicted: 7 });
});
