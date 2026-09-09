#!/usr/bin/env node
import { scanRepositories } from './repositories.js';

const help = `Repo Lens — a quick overview of your local Git repositories

Usage: node src/cli.js [directory] [--json]

Scans the directory itself and its immediate child folders.
  --json       Output structured JSON
  -h, --help   Show this help

Exit codes: 0 success, 1 filesystem/Git error, 2 invalid arguments.
`;

// Prevent repository names and commit subjects from injecting terminal controls.
const printable = value => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) { console.log(help); return; }
  const unknown = args.find(arg => arg.startsWith('-') && arg !== '--json');
  const positional = args.filter(arg => !arg.startsWith('-'));
  if (unknown || positional.length > 1) {
    console.error(unknown ? `Unknown option: ${printable(unknown)}` : 'Expected at most one directory.');
    process.exitCode = 2;
    return;
  }
  const result = await scanRepositories(positional[0] ?? '.');
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    if (!result.repositories.length) console.log('No Git repositories found.');
    for (const repo of result.repositories) {
      console.log(`${repo.dirty ? '[changed]' : '[clean]'} ${printable(repo.name)} (${printable(repo.branch)})`);
      console.log(`  ${printable(repo.lastCommit ?? 'No commits yet')}`);
    }
    for (const error of result.errors) console.error(`Error: ${printable(error.path)}: ${printable(error.message)}`);
  }
  if (result.errors.length) process.exitCode = 1;
}

main(process.argv.slice(2)).catch(error => {
  if (process.argv.includes('--json')) console.log(JSON.stringify({ repositories: [], errors: [{ message: error.message }] }, null, 2));
  else console.error(`Repo Lens: ${printable(error.message)}`);
  process.exitCode = 1;
});
