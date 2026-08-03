#!/usr/bin/env bun
/**
 * Prints one version's CHANGELOG.md section to stdout.
 *
 *   bun run scripts/changelog-section.ts v2.10.0
 *
 * Used by .github/workflows/publish-npm.yml so the GitHub Release body is the
 * same text users see in the in-app "what's new" feed. Exits 1 (with nothing on
 * stdout) when the version has no section, which is the workflow's signal to
 * fall back to a generated commit list.
 *
 * The version arrives as argv, never spliced into a shell string — see the
 * workflow's comment about maintainer-supplied but shell-unsafe input.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractChangelogSection, normalizeVersionArg } from './releaseCore.ts'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: bun run scripts/changelog-section.ts <version>')
  process.exit(1)
}

const changelogPath = join(import.meta.dir, '..', 'CHANGELOG.md')
let content: string
try {
  content = readFileSync(changelogPath, 'utf8')
} catch {
  console.error(`[changelog] cannot read ${changelogPath}`)
  process.exit(1)
}

const section = extractChangelogSection(content, normalizeVersionArg(arg))
if (!section) {
  console.error(`[changelog] no section for ${arg} in CHANGELOG.md`)
  process.exit(1)
}

console.log(section)
