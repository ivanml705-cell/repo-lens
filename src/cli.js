#!/usr/bin/env node
import { scanRepositories } from './repositories.js';
import { parseArgs } from 'node:util';

const help = `Repo Lens — a quick overview of your local Git repositories

Usage: node src/cli.js [directory] [--dirty] [--name <text>] [--json]

Scans the directory itself and its immediate child folders.
  --json       Output structured JSON
  --dirty      Show only repositories with local changes
  --name TEXT  Match part of a repository name (case-insensitive)
  -h, --help   Show this help

Filters can be combined. Use -- before a directory starting with a dash.

Exit codes: 0 success, 1 filesystem/Git error, 2 invalid arguments.
`;

// Prevent repository names and commit subjects from injecting terminal controls.
const printable = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

async function main(args) {
  let values, positionals;
  try {
    ({ values, positionals } = parseArgs({
      args, allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        dirty: { type: 'boolean' },
        name: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
    if (positionals.length > 1) throw new Error('Expected at most one directory.');
    if (values.name !== undefined && !values.name.trim()) throw new Error('--name requires non-empty text.');
  } catch (error) {
    console.error(printable(error.message));
    process.exitCode = 2;
    return;
  }
  if (values.help) { console.log(help); return; }
  let result;
  try {
    result = await scanRepositories(positionals[0] ?? '.');
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
    if (!result.repositories.length) console.log(values.dirty || values.name !== undefined
      ? 'No Git repositories match the filters.' : 'No Git repositories found.');
    for (const repo of result.repositories) {
      console.log(`${repo.dirty ? '[changed]' : '[clean]'} ${printable(repo.name)} (${printable(repo.branch)})`);
      console.log(`  ${printable(repo.lastCommit ?? 'No commits yet')}`);
    }
    for (const error of result.errors) console.error(`Error: ${printable(error.path)}: ${printable(error.message)}`);
  }
  if (result.errors.length) process.exitCode = 1;
}

main(process.argv.slice(2)).catch(error => {
  console.error(`Repo Lens: ${printable(error.message)}`);
  process.exitCode = 1;
});
