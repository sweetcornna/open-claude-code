import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { supportsExtendedKeys } from '../terminal.js'

const MANAGED_ENV_KEYS = ['WT_SESSION', 'TERM_PROGRAM'] as const

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of MANAGED_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of MANAGED_ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('supportsExtendedKeys', () => {
  test('detects Windows Terminal via WT_SESSION', () => {
    process.env.WT_SESSION = '1'

    expect(supportsExtendedKeys()).toBe(true)
  })

  test('detects Windows Terminal even when TERM_PROGRAM is unrelated', () => {
    process.env.WT_SESSION = '4f1e2b3a-0000-0000-0000-000000000000'
    process.env.TERM_PROGRAM = 'vscode'

    expect(supportsExtendedKeys()).toBe(true)
  })

  test('still honors the TERM_PROGRAM allowlist', () => {
    process.env.TERM_PROGRAM = 'iTerm.app'

    expect(supportsExtendedKeys()).toBe(true)
  })

  test('returns false for an unlisted terminal', () => {
    process.env.TERM_PROGRAM = 'vscode'

    expect(supportsExtendedKeys()).toBe(false)
  })

  test('returns false with neither marker set', () => {
    expect(supportsExtendedKeys()).toBe(false)
  })

  test('no longer relies on the dead windows-terminal TERM_PROGRAM value', () => {
    process.env.TERM_PROGRAM = 'windows-terminal'

    expect(supportsExtendedKeys()).toBe(false)
  })
})
