# Roadmap

Work is split into useful sessions, not a fixed quota of commits. Check off a milestone only after the implementation and relevant tests pass.

- [x] Session 1: scan a folder, show branch/dirty state/latest commit, support JSON, integration tests.
- [x] Session 2: add `--dirty` and name filters, with CLI coverage and examples.
- [x] Session 3: report staged, unstaged, and untracked file counts; handle renames and unusual filenames.
- [x] Session 4: display upstream ahead/behind state without fetching or network requests.
- [x] Session 5: add configurable scan depth and exclusions, with traversal limits.
- [x] Session 6: polish terminal output and documentation; review edge cases and prepare v0.2.

The six-session milestone is complete in v0.2.0. Future maintenance can address bugs and feedback; the next development session can start a new project from the parent folder's idea list.
