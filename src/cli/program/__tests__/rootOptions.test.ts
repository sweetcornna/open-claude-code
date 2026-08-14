/**
 * The real root option chain, parsed in-process.
 *
 * `tests/integration/cli-golden.test.ts` pins the *shape* of the surface (which
 * flags exist) by spawning the CLI; it cannot see what a flag parses to. These
 * tests build the actual `applyRootOptions` chain — the same one `main` uses —
 * and assert on the parsed option values, which is where the two bugs below
 * lived: `--effort xhigh` was rejected by a hand-copied allowlist, and
 * `--permission-mode manual` (upstream's spelling for `default`) was unknown.
 *
 * No mocks: `applyRootOptions` is a pure Commander chain.
 */
import { describe, expect, test } from 'bun:test'
import { Command } from '@commander-js/extra-typings'
import { EFFORT_LEVELS } from 'src/utils/model/effort.js'
import { applyRootOptions } from '../rootOptions.js'

type ParsedOptions = Record<string, unknown>

function parse(argv: string[]): ParsedOptions {
  const program = new Command()
  program.exitOverride()
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  })
  applyRootOptions(program as never)
  program.parse(['node', 'occ', ...argv])
  return program.opts() as ParsedOptions
}

describe('--effort', () => {
  test('accepts every level in EFFORT_LEVELS, including xhigh', () => {
    // xhigh is the factory default for most provider families (tierDefaults),
    // so a CLI that rejects it cannot express the default.
    for (const level of EFFORT_LEVELS) {
      expect(parse(['--effort', level]).effort).toBe(level)
    }
    expect(EFFORT_LEVELS).toContain('xhigh')
  })

  test('lowercases the input', () => {
    expect(parse(['--effort', 'XHigh']).effort).toBe('xhigh')
  })

  test('rejects a value outside EFFORT_LEVELS and names the allowed set', () => {
    expect(() => parse(['--effort', 'turbo'])).toThrow(
      /low, medium, high, xhigh, max/,
    )
  })
})

describe('--permission-mode', () => {
  test('passes real modes through unchanged', () => {
    for (const mode of [
      'acceptEdits',
      'bypassPermissions',
      'default',
      'dontAsk',
      'plan',
      'auto',
    ]) {
      expect(parse(['--permission-mode', mode]).permissionMode).toBe(mode)
    }
  })

  test('normalizes the upstream "manual" alias to default', () => {
    // Not a fifth mode: downstream `mode === 'default'` checks must keep working.
    expect(parse(['--permission-mode', 'manual']).permissionMode).toBe(
      'default',
    )
  })

  test('rejects an unknown mode', () => {
    expect(() => parse(['--permission-mode', 'yolo'])).toThrow(
      /Allowed choices are/,
    )
  })
})
