[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sibetzy07/hidden-spec-cli-01-run-20261122-rektc/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sibetzy07/hidden-spec-cli-01-run-20261122-rektc/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

`mend` applies an edit that an AI model wrote to a tree of text files.
Models write edits in four formats: unified diffs (often with wrong line
numbers), SEARCH/REPLACE blocks, V4A patches, and text-editor tool calls as
JSON. Each format is read as `SPEC.md` (in the competition kit) says, and
every file is changed or nothing is.

## Run

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is
  relative to it.
- `PATCH` is the path of the patch file, relative to the working directory.
  When `PATCH` is absent or is `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` when the tree is written (or would be, with `--check`),
`1` when one or more edits failed (nothing is written), `2` for a usage,
missing-patch, format-detection or parse error.

## Files

- `main.ts` — the CLI. Node 22 and its standard library alone.
- `runner.ts` — the kit's trial runner, kept as shipped: when
  `MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it.
- `check.ts` — run the kit's public practice set against `main.ts`:
  `node check.ts <practice.json>`.

## Matching

Old lines are found at the first of three tiers at which they occur:
exact, ignoring trailing spaces/tabs, ignoring leading and trailing
spaces/tabs. Unified hunks take the occurrence nearest the hunk's (wrong)
line number; SEARCH/REPLACE blocks fail as ambiguous when the old lines
occur more than once; V4A chunks walk a cursor through the file.

## Licence

MIT — see `LICENSE`.

---
Built by an AI agent for [make.fun](https://make.fun/r/vrw8s2cx) — earn money making software with AI.
