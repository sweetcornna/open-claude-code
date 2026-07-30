import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import {
  legacyClaudeConfigDir,
  occConfigDir,
  occConfigPath,
  PROJECT_DIR_NAME,
} from '../paths.js'

const OCC = 'OCC_CONFIG_DIR'
const LEGACY = 'CLAUDE_CONFIG_DIR'

let savedOcc: string | undefined
let savedLegacy: string | undefined

function clearEnv(): void {
  delete process.env[OCC]
  delete process.env[LEGACY]
  // occConfigDir is memoized on both env vars; drop the memo so each case
  // resolves fresh.
  occConfigDir.cache.clear?.()
}

beforeEach(() => {
  savedOcc = process.env[OCC]
  savedLegacy = process.env[LEGACY]
  clearEnv()
})

afterEach(() => {
  clearEnv()
  if (savedOcc !== undefined) process.env[OCC] = savedOcc
  if (savedLegacy !== undefined) process.env[LEGACY] = savedLegacy
  occConfigDir.cache.clear?.()
})

describe('occConfigDir', () => {
  test('defaults to ~/.occ, not the official Claude Code directory', () => {
    expect(occConfigDir()).toBe(join(homedir(), '.occ').normalize('NFC'))
    expect(occConfigDir()).not.toBe(join(homedir(), '.claude').normalize('NFC'))
  })

  test('honours OCC_CONFIG_DIR', () => {
    process.env[OCC] = '/tmp/occ-explicit'
    occConfigDir.cache.clear?.()
    expect(occConfigDir()).toBe('/tmp/occ-explicit')
  })

  test('falls back to the deprecated CLAUDE_CONFIG_DIR', () => {
    process.env[LEGACY] = '/tmp/legacy-explicit'
    occConfigDir.cache.clear?.()
    expect(occConfigDir()).toBe('/tmp/legacy-explicit')
  })

  test('prefers OCC_CONFIG_DIR over CLAUDE_CONFIG_DIR when both are set', () => {
    process.env[OCC] = '/tmp/occ-wins'
    process.env[LEGACY] = '/tmp/legacy-loses'
    occConfigDir.cache.clear?.()
    expect(occConfigDir()).toBe('/tmp/occ-wins')
  })

  test('memo key covers both env vars, so switching one does not return a stale value', () => {
    // Regression guard: the original helper keyed its memo on CLAUDE_CONFIG_DIR
    // alone. With two vars in play, a key that ignores one would serve a value
    // cached under the other.
    process.env[LEGACY] = '/tmp/first'
    expect(occConfigDir()).toBe('/tmp/first')

    process.env[OCC] = '/tmp/second'
    expect(occConfigDir()).toBe('/tmp/second')

    delete process.env[OCC]
    expect(occConfigDir()).toBe('/tmp/first')
  })

  test('normalizes to NFC so composed and decomposed home paths agree', () => {
    process.env[OCC] = '/tmp/é'.normalize('NFD')
    occConfigDir.cache.clear?.()
    expect(occConfigDir()).toBe('/tmp/é'.normalize('NFC'))
  })
})

describe('legacyClaudeConfigDir', () => {
  test('always points at ~/.claude regardless of occ overrides', () => {
    process.env[OCC] = '/tmp/somewhere-else'
    occConfigDir.cache.clear?.()
    expect(legacyClaudeConfigDir()).toBe(
      join(homedir(), '.claude').normalize('NFC'),
    )
  })
})

describe('occConfigPath', () => {
  test('joins segments under the config root', () => {
    process.env[OCC] = '/tmp/occ-root'
    occConfigDir.cache.clear?.()
    expect(occConfigPath('projects', 'a.jsonl')).toBe(
      '/tmp/occ-root/projects/a.jsonl',
    )
  })
})

describe('PROJECT_DIR_NAME', () => {
  test('is .occ so project assets do not collide with official Claude Code', () => {
    expect(PROJECT_DIR_NAME).toBe('.occ')
  })
})
