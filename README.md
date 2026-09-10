# Repo Lens

A small, dependency-free CLI that gives you a quick overview of your local Git repositories.

**Status: early development.** Repository scanning and filters are working; richer summaries will follow over several sessions.

## Requirements

- Node.js 22 or newer
- Git available on your PATH

## Run

```sh
node src/cli.js /path/to/projects
node src/cli.js /path/to/projects --json
node src/cli.js --help
```

On Windows, quote paths containing spaces:

```powershell
node src/cli.js "C:\Users\you\Documents\GitHubProjects"
```

No package installation is required. The tool reads the selected directory and its immediate child folders; it does not recursively crawl your disk or modify your repositories.

Example output:

```text
[clean] notes-cli (main)
  Add Markdown export
[changed] repo-lens (main)
  Add local repository scanning
```

The scan includes ordinary repositories and Git worktrees. Empty repositories display `No commits yet`; detached checkouts display `detached:<commit>`. Bare repositories are outside the initial scope.

JSON output contains `repositories` and `errors`. Each repository includes `name`, `path`, `branch`, `dirty`, and `lastCommit`. A failed repository does not prevent other repositories from being reported. Exit code `1` indicates scan errors; `2` indicates invalid arguments.

## Filter repositories

```sh
node src/cli.js /path/to/projects --dirty
node src/cli.js /path/to/projects --name api
node src/cli.js /path/to/projects --dirty --name api --json
```

`--dirty` selects repositories with staged, unstaged, or untracked changes.
`--name TEXT` matches a literal part of the folder name, ignoring case; it also accepts `--name=TEXT`. Quote names containing spaces. Empty or whitespace-only values are rejected.

Combine both filters to show only matching names with local changes. Filters work in text and JSON output, and options can appear before or after the directory. Use `--` before a directory starting with a dash.

No matches is a successful result: text output says `No Git repositories match the filters.`, while JSON contains an empty `repositories` array. Filtering applies after scanning, so scan errors remain visible and still produce exit code `1` even when no repositories match.

## Development

```sh
npm test
```

Tests use temporary Git repositories and require no network access. See [ROADMAP.md](ROADMAP.md) for planned milestones and [CHANGELOG.md](CHANGELOG.md) for completed work.
