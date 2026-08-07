#!/usr/bin/env bash
#
# Run the whole unit suite one top-level directory at a time.
#
# Bun runs every test file of an invocation in ONE process, and `mock.module`
# is process-global and last-write-wins. Sharding per directory hard-isolates
# cross-directory mock state: a file's mocks can only reach its own directory.
# That is the difference that ended the 55 consecutive red CI runs between
# v2.11.0 and v2.30.0 — not any single test fix.
#
# Which means an UNSHARDED `bun test` is a different execution mode, not a
# stricter version of this one. It has never been proven on a Linux runner, so
# neither CI nor the publish gate uses it.
#
# Lives in a script rather than inline in the workflow because ci.yml and
# publish-npm.yml both need identical semantics; two copies of the loop below
# would drift, and the failure it protects against is invisible on macOS.
#
# Usage:
#   scripts/test-shards.sh              # plain run
#   scripts/test-shards.sh --coverage   # per-shard lcov, concatenated
#
# Exit status is 0 only if EVERY directory passed standalone.

# `set +e` is required, not merely omitting `-e`: GitHub Actions invokes `run:`
# steps as `bash -e {0}`, so errexit is already on when this script is sourced
# into that context.
set +e
set -uo pipefail

coverage=0
if [ "${1:-}" = "--coverage" ]; then
  coverage=1
  rm -rf coverage && mkdir -p coverage
fi

shard=0
failed=()

for d in src/* packages/* tests/integration scripts; do
  [ -d "$d" ] || continue
  # Skip directories with no tests at all rather than letting `bun test` treat
  # "no files matched" as a failure.
  if ! find "$d" \( -name '*.test.ts' -o -name '*.test.tsx' \) -print -quit | grep -q .; then
    continue
  fi

  shard=$((shard + 1))
  echo "──── shard ${shard}: ${d}"

  if [ "$coverage" = "1" ]; then
    bun test --coverage --coverage-reporter lcov \
      --coverage-dir "coverage/shard-${shard}" "$d" 2>&1 \
      | grep -vE '^\s*(\(pass\)|\(skip\))' | sed '/^.*\/__tests__\/.*:$/d' | cat -s
  else
    bun test "$d" 2>&1 \
      | grep -vE '^\s*(\(pass\)|\(skip\))' | sed '/^.*\/__tests__\/.*:$/d' | cat -s
  fi

  # PIPESTATUS[0], not $? — the pipeline's status is grep/sed/cat's, and
  # `grep -v` exits 1 whenever it filters out every line.
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    failed+=("$d")
    echo "::error title=Test shard failed::${d}"
  fi

  # Tiny shards can produce no lcov at all — the artifact just needs the union
  # of what was measured, not a file per shard.
  if [ "$coverage" = "1" ] && [ -f "coverage/shard-${shard}/lcov.info" ]; then
    cat "coverage/shard-${shard}/lcov.info" >> coverage/lcov.info
  fi
done

# Deliberately no early abort: stopping at the first red shard hides every
# shard after it. That is not hypothetical — one poisoned mock in src/utils
# (shard 22 of 34) meant src/workflow, all of packages/*, tests/integration and
# scripts had never once been exercised on CI.
if [ ${#failed[@]} -ne 0 ]; then
  echo "──── ${#failed[@]} of ${shard} shards failed: ${failed[*]}"
  exit 1
fi

echo "──── all ${shard} shards passed"
