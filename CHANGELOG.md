# Changelog

## Unreleased — 2026-09-10

- Add `--dirty` to show repositories with local changes.
- Add `--name TEXT` for case-insensitive substring matching of repository names.
- Combine filters in text and JSON output while preserving scan errors.
- Validate filter arguments and support `--` before dash-prefixed directories.
- Cover filters, invalid input, empty results, and partial failures with CLI integration tests.

## 0.1.0 — 2026-09-09

- Scan the selected folder and its immediate children for Git repositories.
- Show branch, local modifications, and latest commit subject.
- Support structured JSON output, empty repositories, and detached HEAD.
- Report individual scan failures without discarding successful results.
- Add integration tests and CI across Windows and Linux.
