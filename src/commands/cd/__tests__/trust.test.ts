import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { normalizePathForConfigKey } from 'src/utils/filesystem/path.js'
import { findCanonicalGitRoot } from 'src/utils/git/git.js'
import { persistedTrustKeyForPath } from '../trust.js'

describe('persistedTrustKeyForPath', () => {
  test('falls back to the resolved path outside a repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'occ-cd-trust-'))
    try {
      expect(persistedTrustKeyForPath(dir)).toBe(
        normalizePathForConfigKey(findCanonicalGitRoot(dir) ?? resolve(dir)),
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('uses the git root for a subdirectory of a repo', () => {
    // This repo is a git checkout, so a nested directory must map to the root
    // key — that is what makes "trusting it trusts the whole repository" true.
    // Anchored on import.meta.dir, never on process.cwd(): other suites in the
    // shard chdir and pin cwd state, so a relative anchor is not reliable.
    const nested = resolve(import.meta.dir, '..')
    const gitRoot = findCanonicalGitRoot(nested)
    expect(gitRoot).not.toBeNull()
    expect(persistedTrustKeyForPath(nested)).toBe(
      normalizePathForConfigKey(gitRoot as string),
    )
  })
})
