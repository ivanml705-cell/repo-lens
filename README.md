# Repo Lens

A small, dependency-free CLI that gives you a quick overview of your local Git repositories.

**Status: early development.** Repository scanning, filters, and file change counts are working; upstream summaries will follow.

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
  0 staged, 0 unstaged, 0 untracked
  Add Markdown export
[changed] repo-lens (main)
  1 staged, 2 unstaged, 3 untracked
  Add local repository scanning
```

The scan includes ordinary repositories and Git worktrees. Empty repositories display `No commits yet`; detached checkouts display `detached:<commit>`. Bare repositories are outside the initial scope.

JSON output contains `repositories` and `errors`. Each repository includes `name`, `path`, `branch`, `dirty`, `lastCommit`, and `changes`. A failed repository does not prevent other repositories from being reported. Exit code `1` indicates scan errors; `2` indicates invalid arguments.

## Change counts

Every repository includes a `changes` object in JSON:

```json
{ "staged": 1, "unstaged": 2, "untracked": 3, "conflicted": 0 }
```

- `staged`: paths with changes prepared for the next commit, including additions, deletions, and detected renames.
- `unstaged`: tracked paths with working-tree changes not yet staged.
- `untracked`: individual new files, including files inside new folders; ignored files are excluded.
- `conflicted`: paths with unresolved merge conflicts, counted separately from staged and unstaged changes. Text output shows this count when nonzero.

A path with both staged and unstaged edits contributes to both counts; their sum is not a unique file total. A detected rename counts once in each applicable category. Empty and clean repositories have zero counts. Submodules are counted as repository entries, not as their individual internal files; Git's submodule ignore settings apply.

The parser uses Git's [NUL-separated porcelain format](https://git-scm.com/docs/git-status#_porcelain_format_version_1), preserving filenames containing spaces, Unicode, tabs, or line breaks. Rename detection and individual untracked-file reporting are explicitly enabled, regardless of local status configuration.

## Filter repositories

```sh
node src/cli.js /path/to/projects --dirty
node src/cli.js /path/to/projects --name api
node src/cli.js /path/to/projects --dirty --name api --json
```

`--dirty` selects repositories with staged, unstaged, untracked, or conflicted changes.
`--name TEXT` matches a literal part of the folder name, ignoring case; it also accepts `--name=TEXT`. Quote names containing spaces. Empty or whitespace-only values are rejected.

Combine both filters to show only matching names with local changes. Filters work in text and JSON output, and options can appear before or after the directory. Use `--` before a directory starting with a dash.

No matches is a successful result: text output says `No Git repositories match the filters.`, while JSON contains an empty `repositories` array. Filtering applies after scanning, so scan errors remain visible and still produce exit code `1` even when no repositories match.

## Development

```sh
npm test
```

Tests use temporary Git repositories and require no network access. See [ROADMAP.md](ROADMAP.md) for planned milestones and [CHANGELOG.md](CHANGELOG.md) for completed work.
