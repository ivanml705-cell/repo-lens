#!/usr/bin/env node
import { scanRepositories, validateScanOptions } from './repositories.js';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const help = `Repo Lens — a quick overview of your local Git repositories

Usage: node src/cli.js [directory] [options]

Scans the directory itself and its immediate child folders by default.
  --json          Output structured JSON
  --dirty         Show only repositories with local changes
  --name TEXT     Match part of a repository name (case-insensitive)
  --depth N       Subfolder depth, 0 to 10 (default: 1)
  --exclude NAME  Skip a folder name at every level; repeatable
  --max-dirs N    Maximum visited directories, 1 to 100000 (default: 1000)
  -v, --version   Show the installed version
  -h, --help      Show this help

Filters can be combined. Use -- before a directory starting with a dash.
Upstream counts use local refs only; no fetch is performed.

Exit codes: 0 success, 1 filesystem/Git error, 2 invalid arguments.
`;

// Prevent repository names and commit subjects from injecting terminal controls.
const printable = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

async function main(args) {
  let values, positionals, scanOptions;
  try {
    ({ values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        dirty: { type: 'boolean' },
        name: { type: 'string' },
        depth: { type: 'string' },
        exclude: { type: 'string', multiple: true },
        'max-dirs': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
    if (positionals.length > 1) throw new Error('Expected at most one directory.');
    if (values.name !== undefined && !values.name.trim()) throw new Error('--name requires non-empty text.');
    for (const option of ['depth', 'max-dirs']) {
      if (values[option] !== undefined && !/^\d+$/.test(values[option])) throw new Error(`--${option} requires a whole decimal number.`);
    }
    scanOptions = validateScanOptions({
      depth: values.depth === undefined ? undefined : Number(values.depth),
      exclude: values.exclude,
      maxDirs: values['max-dirs'] === undefined ? undefined : Number(values['max-dirs']),
    });
  } catch (error) {
    console.error(printable(error.message));
    process.exitCode = 2;
    return;
  }
  if (values.help) { console.log(help); return; }
  if (values.version) { console.log(`repo-lens ${version}`); return; }
  let result;
  try {
    result = await scanRepositories(positionals[0] ?? '.', scanOptions);
  } catch (error) {
    if (values.json) console.log(JSON.stringify({ repositories: [], errors: [{ message: error.message }] }, null, 2));
    else console.error(`Repo Lens: ${printable(error.message)}`);
    process.exitCode = 1;
    return;
  }
  result.repositories = result.repositories.filter(repo =>
    (!values.dirty || repo.dirty) &&
    (values.name === undefined || repo.name.toLowerCase().includes(values.name.toLowerCase()))
  );
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    if (!result.repositories.length) console.log(result.errors.length
      ? 'No repositories could be reported.'
      : values.dirty || values.name !== undefined
        ? 'No Git repositories match the filters.' : 'No Git repositories found.');
    for (const repo of result.repositories) {
      console.log(`${repo.dirty ? '[changed]' : '[clean]'} ${printable(repo.name)} (${printable(repo.branch)})`);
      console.log(`  Path: ${printable(repo.path)}`);
      const { staged, unstaged, untracked, conflicted } = repo.changes;
      console.log(`  ${staged} staged, ${unstaged} unstaged, ${untracked} untracked${conflicted ? `, ${conflicted} conflicted` : ''}`);
      const upstream = repo.upstream;
      if (upstream.status === 'tracked') {
        console.log(`  ${printable(upstream.name)}: ${upstream.ahead} ahead, ${upstream.behind} behind (local refs)`);
      } else {
        const labels = { none: 'No upstream configured', unborn: 'Upstream unavailable: no commits yet',
          detached: 'Upstream unavailable: detached HEAD', gone: `Upstream ${printable(upstream.name)} unavailable locally` };
        console.log(`  ${labels[upstream.status]}`);
      }
      console.log(`  ${printable(repo.lastCommit ?? 'No commits yet')}`);
      console.log();
    }
    const changed = result.repositories.filter(repo => repo.dirty).length;
    const count = result.repositories.length;
    console.log(`Shown: ${count} ${count === 1 ? 'repository' : 'repositories'} (${changed} changed, ${count - changed} clean); ${result.errors.length} scan errors.`);
    if (result.errors.length) console.log('Scan incomplete: review the errors below.');
    for (const error of result.errors) console.error(`Error: ${printable(error.path)}: ${printable(error.message)}`);
  }
  if (result.errors.length) process.exitCode = 1;
}

main(process.argv.slice(2)).catch(error => {
  console.error(`Repo Lens: ${printable(error.message)}`);
  process.exitCode = 1;
});
