// Parse git status --porcelain=v1 -z. Do not trim: a leading space is
// the index status, and filenames may contain whitespace or line breaks.
export function countChanges(status) {
  const counts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  const records = status.split('\0');
  const conflicts = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
  for (let i = 0; i < records.length; i++) {
    if (!records[i]) continue;
    const code = records[i].slice(0, 2);
    if (code === '??') counts.untracked++;
    else if (code === '!!') continue;
    else if (conflicts.has(code)) counts.conflicted++;
    else {
      if (code[0] !== ' ') counts.staged++;
      if (code[1] !== ' ') counts.unstaged++;
      // A rename/copy includes a second NUL-separated path, not another file.
      if (/[RC]/.test(code)) i++;
    }
  }
  return counts;
}
