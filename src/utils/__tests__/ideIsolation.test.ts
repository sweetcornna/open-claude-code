import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { occConfigDir } from 'src/config/paths.js'
import { canDeleteIdeLockfile } from '../ide.js'

const originalOccConfigDir = process.env.OCC_CONFIG_DIR
const root = realpathSync(mkdtempSync(join(tmpdir(), 'occ-ide-isolation-')))
const occRoot = join(root, '.occ')
const occIdeDir = join(occRoot, 'ide')
const legacyIdeDir = join(root, '.claude', 'ide')

beforeEach(() => {
  process.env.OCC_CONFIG_DIR = occRoot
  occConfigDir.cache.clear?.()
  rmSync(occIdeDir, { recursive: true, force: true })
  mkdirSync(occIdeDir, { recursive: true })
  mkdirSync(legacyIdeDir, { recursive: true })
})

afterAll(() => {
  if (originalOccConfigDir === undefined) {
    delete process.env.OCC_CONFIG_DIR
  } else {
    process.env.OCC_CONFIG_DIR = originalOccConfigDir
  }
  occConfigDir.cache.clear?.()
  rmSync(root, { recursive: true, force: true })
})

describe('IDE lockfile isolation', () => {
  test('allows cleanup only in the occ IDE directory', () => {
    const occLockfile = join(occIdeDir, 'occ.lock')
    const legacyLockfile = join(legacyIdeDir, 'official.lock')
    writeFileSync(occLockfile, '')
    writeFileSync(legacyLockfile, '')

    expect(canDeleteIdeLockfile(occLockfile)).toBe(true)
    expect(canDeleteIdeLockfile(legacyLockfile)).toBe(false)
  })

  test('rejects an occ IDE directory redirected through a symlink', () => {
    rmSync(occIdeDir, { recursive: true, force: true })
    symlinkSync(
      legacyIdeDir,
      occIdeDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const redirectedLockfile = join(occIdeDir, 'official.lock')
    writeFileSync(redirectedLockfile, '')

    expect(canDeleteIdeLockfile(redirectedLockfile)).toBe(false)
  })
})
