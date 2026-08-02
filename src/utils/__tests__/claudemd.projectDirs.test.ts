import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import {
  resetStateForTests,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { occConfigDir } from '../../config/paths.js'
import {
  cleanupTempDir,
  createTempDir,
  writeTempFile,
} from '../../../tests/mocks/file-system.js'
import {
  clearMemoryFileCaches,
  getConditionalRulesForCwdLevelDirectory,
  getMemoryFiles,
} from '../session/claudemd.js'

const originalOccConfigDir = process.env.OCC_CONFIG_DIR
let tempDir = ''
let configDir = ''

beforeEach(async () => {
  tempDir = await realpath(await createTempDir('claudemd-project-dirs-'))
  configDir = join(tempDir, 'user-config')
  process.env.OCC_CONFIG_DIR = configDir
  occConfigDir.cache.clear?.()
  resetStateForTests()
  setOriginalCwd(tempDir)
  setProjectRoot(tempDir)
  clearMemoryFileCaches()
})

afterEach(async () => {
  const legacyDir = join(tempDir, '.claude')
  await chmod(legacyDir, 0o700).catch(() => {})
  clearMemoryFileCaches()
  resetStateForTests()
  if (originalOccConfigDir === undefined) {
    delete process.env.OCC_CONFIG_DIR
  } else {
    process.env.OCC_CONFIG_DIR = originalOccConfigDir
  }
  occConfigDir.cache.clear?.()
  if (tempDir) {
    await cleanupTempDir(tempDir)
  }
})

describe('project memory directory isolation', () => {
  test('loads legacy memory read-only before active occ memory', async () => {
    const legacyMemory = await writeTempFile(
      tempDir,
      '.claude/CLAUDE.md',
      'legacy project memory',
    )
    const legacyRule = await writeTempFile(
      tempDir,
      '.claude/rules/legacy.md',
      'legacy project rule',
    )
    const occMemory = await writeTempFile(
      tempDir,
      '.occ/CLAUDE.md',
      'active occ project memory',
    )
    const occRule = await writeTempFile(
      tempDir,
      '.occ/rules/current.md',
      'active occ project rule',
    )
    const legacyDir = join(tempDir, '.claude')
    const legacyEntriesBefore = await readdir(legacyDir, { recursive: true })
    await chmod(legacyDir, 0o500)

    const files = await getMemoryFiles()
    const paths = files.map(file => file.path)

    for (const path of [legacyMemory, legacyRule, occMemory, occRule]) {
      expect(paths).toContain(path)
      expect(files.find(file => file.path === path)?.type).toBe('Project')
    }
    expect(paths.indexOf(legacyMemory)).toBeLessThan(paths.indexOf(occMemory))
    expect(paths.indexOf(legacyRule)).toBeLessThan(paths.indexOf(occRule))
    expect(await readdir(legacyDir, { recursive: true })).toEqual(
      legacyEntriesBefore,
    )
  })

  test('loads matching conditional rules from the active occ directory', async () => {
    const matchingRule = await writeTempFile(
      tempDir,
      '.occ/rules/typescript.md',
      '---\npaths:\n  - "src/**/*.ts"\n---\nUse TypeScript rules.',
    )

    const matching = await getConditionalRulesForCwdLevelDirectory(
      tempDir,
      join(tempDir, 'src', 'feature.ts'),
      new Set(),
    )
    const nonMatching = await getConditionalRulesForCwdLevelDirectory(
      tempDir,
      join(tempDir, 'docs', 'guide.md'),
      new Set(),
    )

    expect(matching.map(file => file.path)).toContain(matchingRule)
    expect(matching[0]?.globs).toEqual(['src/**/*.ts'])
    expect(nonMatching.map(file => file.path)).not.toContain(matchingRule)
  })
})
