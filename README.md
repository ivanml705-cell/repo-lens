# Repo Lens

A small, dependency-free CLI that gives you a quick overview of your local Git repositories.

**Status: early development.** Configurable discovery, filters, file change counts, and upstream summaries are working. Final polish for v0.2 is next.

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

No package installation is required. By default, the tool reads the selected directory and its immediate child folders. Use `--depth` to explore further. It does not modify your repositories.

Example output:

```text
[clean] notes-cli (main)
  0 staged, 0 unstaged, 0 untracked
  origin/main: 0 ahead, 0 behind (local refs)
  Add Markdown export
[changed] repo-lens (main)
  1 staged, 2 unstaged, 3 untracked
  origin/main: 2 ahead, 1 behind (local refs)
  Add local repository scanning
```

The scan includes ordinary repositories and Git worktrees. Empty repositories display `No commits yet`; detached checkouts display `detached:<commit>`. Bare repositories are outside the initial scope.

JSON output contains `repositories` and `errors`. Each repository includes `name`, `path`, `branch`, `dirty`, `lastCommit`, `changes`, and `upstream`. A failed repository does not prevent other repositories from being reported. Exit code `1` indicates scan errors; `2` indicates invalid arguments.

## Discover nested repositories

```sh
node src/cli.js /path/to/projects --depth 3
node src/cli.js /path/to/projects --depth 3 --exclude node_modules --exclude archive
node src/cli.js /path/to/projects --depth 2 --max-dirs 2000 --dirty --json
```

- `--depth N`: root is depth `0`, immediate children are depth `1` (the default). Accepts integers from `0` to `10`. Nested repositories are discovered even inside another repository, up to this depth.
- `--exclude NAME`: skip folders with this exact, case-sensitive name at any level, including their entire subtree. Repeat the flag for multiple names. Names are literal, not globs or relative paths. Quote names containing spaces. The explicitly selected root is always considered.
- `--max-dirs N`: visit at most `N` directories, including the root and non-repository folders. Default `1000`, allowed range `1` to `100000`. Excluded folders and child directory links do not consume this budget.

Discovery uses a sorted depth-first traversal. It always skips `.git` directories and does not follow child symbolic links or Windows junctions, preventing loops and traversal outside the chosen tree. An explicitly selected root may itself be a link.

If more eligible folders remain when the budget is exhausted, the command returns the repositories already found, adds an error explaining that the scan is incomplete, and exits with code `1`. Child-folder read errors also preserve other results. Reaching the requested depth is a normal, successful boundary.

These options control repository discovery only: exclusions and the directory budget do not restrict Git's own file-status inspection inside a discovered repository. `--name` and `--dirty` filter the results after discovery and do not reduce its budget.

## Upstream comparison

The summary compares the current branch with its configured upstream (a remote-tracking or local branch). `ahead` counts commits only on the current branch; `behind` counts commits only on the upstream. Both may be positive when the branches diverge.

```json
{ "status": "tracked", "name": "origin/main", "ahead": 2, "behind": 1 }
```

The `upstream.status` field distinguishes these cases:

| Status | Meaning | Counts |
| --- | --- | --- |
| `tracked` | Both refs can be compared | Nonnegative integers |
| `none` | No upstream is configured | `null` |
| `gone` | Configured upstream ref is unavailable locally | `null` |
| `unborn` | Current branch has no commits yet | `null` |
| `detached` | HEAD is not attached to a branch | `null` |

`name` is the upstream's short ref name for `tracked` and `gone`, otherwise `null`. Unavailable counts are never presented as zero and these expected states do not fail a scan.

Counts use locally available refs and history only. Repo Lens does not fetch, push, or contact remotes, and disables lazy fetching. A remote-tracking ref may be stale; `gone` does not prove the branch was deleted on the server. Shallow history can limit the comparison. Update your refs separately if you need fresher results.

`--dirty` still filters file changes, not unpushed commits: a clean repository can be ahead of its upstream. The implementation reads [upstream metadata](https://git-scm.com/docs/git-for-each-ref) and counts the [symmetric commit difference](https://git-scm.com/docs/git-rev-list).

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
