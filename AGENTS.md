# AGENTS.md

**`CLAUDE.md` in this same directory is the single source of truth for how to work in this repo. Read it before doing anything else.**

This file exists because `AGENTS.md` is the cross-tool convention. It deliberately does not duplicate `CLAUDE.md`: it used to be a full copy, the two drifted 783 lines apart, and an audit found 21 factual claims in this file that were wrong (nonexistent workspace packages, a stale feature-flag count, commands whose scripts no longer exist). One source of truth, no copies.

## The three things you must know up front

1. **`bun run precheck` must pass with zero errors before you call any task done.** It runs `tsc --noEmit`, `biome check --fix` and the full `bun test` suite. Note it *rewrites your files* (`check:fix`, not `check`). Current baseline: typecheck clean, biome clean, 5945 pass / 10 skip / 0 fail.

2. **This is a Bun project, not Node.** All imports, builds and execution use Bun APIs (`engines.bun >= 1.3.11`). Do not reach for `npx` — use `bunx`. The pre-commit hook was broken for exactly this reason.

3. **Commit messages follow Conventional Commits**: `<type>: <描述>`, where type is one of `feat` / `fix` / `docs` / `chore` / `refactor`.

## Everything else

See `CLAUDE.md` for the architecture map, the feature-flag system and the `bun:bundle` `feature()` positional constraint, the multi-API compatibility layers, the type rules (no `as any` in production code), and the testing conventions — including the cross-file `mock.module` pollution rules, which are easy to violate and hard to debug.

See `CONTRIBUTING.md` for the workflow side: commit conventions, the cycle-count ratchet, PR expectations, and where each kind of document belongs.
