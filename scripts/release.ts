#!/usr/bin/env bun
/**
 * Release driver: one command brings every version source in line.
 *
 *   bun run release 2.10.0            # bump, gate, commit, tag
 *   bun run release 2.10.0 --dry-run  # print the plan, touch nothing
 *
 * Sources this owns (nothing else in the repo carries a version number):
 *   package.json "version"  → MACRO.VERSION via scripts/defines.ts, and the
 *                             version npm publishes
 *   CHANGELOG.md            → the in-app "what's new" feed (fetched raw from
 *                             main by src/utils/update/releaseNotes.ts) and
 *                             the GitHub Release body
 *   git tag v<version>      → the only trigger for .github/workflows/publish-npm.yml
 *
 * The script stops after creating the tag. Pushing is the human's call:
 * `git push origin main --follow-tags` is what actually publishes, and there is
 * no un-publishing an npm version.
 *
 * Ordering note: the gates run BEFORE anything is written, so a failing gate
 * cannot leave a half-bumped working tree. This is safe because the bump only
 * touches package.json's version string and CHANGELOG.md — no gate's result
 * depends on either.
 *
 * Pure logic (semver rules, CHANGELOG editing) lives in ./releaseCore.ts and
 * is unit-tested; this file is the side-effect shell.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  draftEntriesFromCommits,
  formatReleaseDate,
  hasChangelogSection,
  insertChangelogSection,
  readPackageVersion,
  replacePackageVersion,
  validateReleaseVersion,
} from './releaseCore.ts'

const PROJECT_ROOT = join(import.meta.dir, '..')
const PACKAGE_JSON = join(PROJECT_ROOT, 'package.json')
const CHANGELOG = join(PROJECT_ROOT, 'CHANGELOG.md')
const RELEASE_BRANCH = 'main'

/**
 * Mirrors what publish-npm.yml will run, so a release that would fail the
 * workflow fails here first — before the tag exists.
 *
 * The suite runs SHARDED (scripts/test-shards.sh), matching the workflow
 * rather than the plain `bun test` that precheck uses. Sharding per directory
 * is what makes the suite deterministic on a Linux runner; running it
 * unsharded here would gate on a different execution mode than the one that
 * actually decides whether publish succeeds.
 *
 * This used to stop at `bun test tests/integration` because the full suite had
 * order-dependent failures on Linux. That cause is gone — the mock-hygiene
 * backlog is at zero and the ratchet guards it.
 */
const GATES: ReadonlyArray<{ label: string; argv: string[] }> = [
  { label: 'typecheck', argv: ['bun', 'run', 'typecheck'] },
  { label: 'cycle ratchet', argv: ['bun', 'run', 'check:cycles'] },
  { label: 'mock hygiene ratchet', argv: ['bun', 'run', 'check:mock-hygiene'] },
  { label: 'full test suite (sharded)', argv: ['./scripts/test-shards.sh'] },
]

function log(message: string): void {
  console.log(`[release] ${message}`)
}

function fail(message: string): never {
  console.error(`[release] FAIL ${message}`)
  process.exit(1)
}

/** Runs a command, capturing stdout. Throws on non-zero exit. */
function capture(argv: string[]): string {
  const [command, ...args] = argv
  if (!command) throw new Error('empty command')
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${argv.join(' ')} exited ${result.status}: ${(result.stderr || '').trim()}`,
    )
  }
  return result.stdout.trim()
}

/** Runs a command, streaming output. Returns success. */
function run(argv: string[]): boolean {
  const [command, ...args] = argv
  if (!command) return false
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  })
  return result.status === 0
}

function tryCapture(argv: string[]): string | null {
  try {
    return capture(argv)
  } catch {
    return null
  }
}

function usage(): never {
  console.error('usage: bun run release <version> [--dry-run]')
  console.error('   e.g. bun run release 2.10.0')
  process.exit(1)
}

interface Args {
  version: string
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  let version: string | undefined
  let dryRun = false
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      usage()
    } else if (arg.startsWith('-')) {
      console.error(`[release] unknown flag: ${arg}`)
      usage()
    } else if (version === undefined) {
      version = arg
    } else {
      console.error(`[release] unexpected argument: ${arg}`)
      usage()
    }
  }
  if (!version) usage()
  return { version, dryRun }
}

/**
 * Clean tree, on main, in sync with origin. A release commit built on top of
 * unrelated local work, or on a branch that diverged from origin, produces a
 * tag whose contents nobody can reproduce from the published history.
 */
function checkRepoState(version: string): void {
  const branch = tryCapture(['git', 'rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== RELEASE_BRANCH) {
    fail(`releases must be cut from ${RELEASE_BRANCH}, currently on ${branch}`)
  }

  const dirty = capture(['git', 'status', '--porcelain'])
  if (dirty) {
    fail(
      `working tree is not clean — commit or stash first:\n${dirty
        .split('\n')
        .map(line => `         ${line.trim()}`)
        .join('\n')}`,
    )
  }

  if (
    tryCapture(['git', 'rev-parse', '-q', '--verify', `refs/tags/v${version}`])
  ) {
    fail(`tag v${version} already exists`)
  }

  // Refresh the remote ref before comparing; tolerate being offline, but say so.
  if (!tryCapture(['git', 'fetch', '--quiet', 'origin', RELEASE_BRANCH])) {
    log(
      `WARN could not fetch origin/${RELEASE_BRANCH} — sync check may be stale`,
    )
  }

  const counts = tryCapture([
    'git',
    'rev-list',
    '--left-right',
    '--count',
    `HEAD...origin/${RELEASE_BRANCH}`,
  ])
  if (!counts) {
    log(
      `WARN no origin/${RELEASE_BRANCH} to compare against — skipping sync check`,
    )
    return
  }
  const [aheadRaw, behindRaw] = counts.split(/\s+/)
  const ahead = Number(aheadRaw ?? 0)
  const behind = Number(behindRaw ?? 0)
  // Behind (or diverged) is fatal: the tag would omit commits that are already
  // published, and the release would silently ship less than main contains.
  // Being merely ahead is normal — `git push --follow-tags` sends those commits
  // and the tag in one go, which is exactly the documented final step.
  if (behind > 0) {
    fail(
      ahead > 0
        ? `HEAD has diverged from origin/${RELEASE_BRANCH} (${ahead} ahead, ${behind} behind) — reconcile first`
        : `HEAD is ${behind} commit(s) behind origin/${RELEASE_BRANCH} — pull first`,
    )
  }
  if (ahead > 0) {
    log(
      `${ahead} unpushed commit(s) on ${RELEASE_BRANCH} — they will be published with the tag`,
    )
  }
}

/** Commit subjects since the last tag, newest first. */
function commitSubjectsSinceLastTag(): { range: string; subjects: string[] } {
  const lastTag = tryCapture(['git', 'describe', '--tags', '--abbrev=0'])
  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD'
  const out = tryCapture([
    'git',
    'log',
    range,
    '--no-merges',
    '--pretty=format:%s',
  ])
  return { range, subjects: out ? out.split('\n') : [] }
}

function main(): void {
  const { version: rawVersion, dryRun } = parseArgs(process.argv.slice(2))

  const packageJson = readFileSync(PACKAGE_JSON, 'utf8')
  const currentVersion = readPackageVersion(packageJson)

  const check = validateReleaseVersion(rawVersion, currentVersion)
  if (!check.ok) fail(check.error)
  const version = check.version
  const tag = `v${version}`

  log(`${currentVersion} -> ${version}${dryRun ? ' (dry run)' : ''}`)
  checkRepoState(version)

  const changelog = readFileSync(CHANGELOG, 'utf8')
  const sectionExists = hasChangelogSection(changelog, version)
  const { range, subjects } = commitSubjectsSinceLastTag()
  const entries = draftEntriesFromCommits(subjects)
  const { content: nextChangelog, inserted } = insertChangelogSection(
    changelog,
    version,
    entries,
    formatReleaseDate(new Date()),
  )
  const nextPackageJson = replacePackageVersion(packageJson, version)

  if (dryRun) {
    console.log('')
    log('plan:')
    console.log(
      `  1. package.json   "version": "${currentVersion}" -> "${version}"`,
    )
    if (sectionExists) {
      console.log(
        `  2. CHANGELOG.md   section "## ${version}" already present — skipped (idempotent)`,
      )
    } else {
      console.log(
        `  2. CHANGELOG.md   insert "## ${version}" with ${entries.length} draft entr${
          entries.length === 1 ? 'y' : 'ies'
        } from \`git log ${range}\`:`,
      )
      for (const entry of entries) {
        console.log(`       - ${entry}`)
      }
    }
    console.log('  3. gates:')
    for (const gate of GATES) {
      console.log(`       ${gate.argv.join(' ')}`)
    }
    console.log(`  4. git commit -m "chore(release): ${tag}"`)
    console.log(`  5. git tag -a ${tag} -m "${tag}"`)
    console.log('')
    log(`nothing written. Next: bun run release ${version}`)
    return
  }

  log('running release gates...')
  for (const gate of GATES) {
    log(`gate: ${gate.argv.join(' ')}`)
    if (!run([...gate.argv])) {
      fail(`gate "${gate.label}" failed — nothing was written`)
    }
  }
  log('all gates passed.')

  // Every write happens after this point, so a rollback only ever has to
  // restore these two files to the contents read above.
  try {
    writeFileSync(PACKAGE_JSON, nextPackageJson)
    writeFileSync(CHANGELOG, nextChangelog)
    log(`package.json: version -> ${version}`)
    log(
      inserted
        ? `CHANGELOG.md: inserted "## ${version}" (${entries.length} draft entries)`
        : `CHANGELOG.md: "## ${version}" already documented — left untouched`,
    )

    capture(['git', 'add', '--', PACKAGE_JSON, CHANGELOG])
    capture(['git', 'commit', '-m', `chore(release): ${tag}`])
  } catch (error) {
    writeFileSync(PACKAGE_JSON, packageJson)
    writeFileSync(CHANGELOG, changelog)
    tryCapture(['git', 'reset', '--', PACKAGE_JSON, CHANGELOG])
    fail(
      `could not create the release commit (files restored): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  try {
    capture(['git', 'tag', '-a', tag, '-m', tag])
  } catch (error) {
    console.error(
      `[release] the release commit landed but tagging failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    fail(`create the tag by hand: git tag -a ${tag} -m "${tag}"`)
  }

  log(`committed and tagged ${tag}.`)
  if (inserted) {
    console.log('')
    log('CHANGELOG entries are a DRAFT of raw commit subjects.')
    log('They ship to users verbatim — in-app release notes and the GitHub')
    log('Release body both read this section. Rewrite them for humans:')
    console.log('       $EDITOR CHANGELOG.md')
    console.log('       git add CHANGELOG.md && git commit --amend --no-edit')
    console.log(`       git tag -f -a ${tag} -m "${tag}"`)
  }
  console.log('')
  log('nothing has been pushed. To publish:')
  console.log('       git push origin main --follow-tags')
  log(`the ${tag} tag triggers publish-npm.yml (npm publish + GitHub Release).`)
}

try {
  main()
} catch (error) {
  // The write phase does its own rollback, so anything reaching here is a
  // failure outside it (bad args, unreadable file). Report it without a stack.
  fail(error instanceof Error ? error.message : String(error))
}
