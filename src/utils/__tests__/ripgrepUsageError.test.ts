import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logMock } from '../../../tests/mocks/log'
import { debugMock } from '../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { ripGrep, RipgrepUsageError } = await import('../filesystem/ripgrep.js')

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'occ-rg-usage-'))
  writeFileSync(join(dir, 'a.txt'), 'hello world\n')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ripGrep exit-2 usage errors', () => {
  test('rejects with RipgrepUsageError when rejectOnInputError is set', async () => {
    // `foo(` = unclosed group → rg exits 2 with "rg: regex parse error".
    await expect(
      ripGrep(['foo('], dir, AbortSignal.timeout(20_000), {
        rejectOnInputError: true,
      }),
    ).rejects.toBeInstanceOf(RipgrepUsageError)
  })

  test('the error message carries ripgrep stderr for the model', async () => {
    let caught: unknown
    try {
      await ripGrep(['foo('], dir, AbortSignal.timeout(20_000), {
        rejectOnInputError: true,
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(RipgrepUsageError)
    expect((caught as Error).message).toContain('regex parse error')
  })

  test('a bad glob also rejects (error parsing glob)', async () => {
    await expect(
      ripGrep(['--glob', '[', 'hello'], dir, AbortSignal.timeout(20_000), {
        rejectOnInputError: true,
      }),
    ).rejects.toBeInstanceOf(RipgrepUsageError)
  })

  test('without rejectOnInputError an invalid regex still resolves to [] (interactive callers)', async () => {
    const result = await ripGrep(['foo('], dir, AbortSignal.timeout(20_000))
    expect(result).toEqual([])
  })

  test('a valid pattern with no matches resolves to [] (exit 1 is not a usage error)', async () => {
    const result = await ripGrep(
      ['definitely-not-present'],
      dir,
      AbortSignal.timeout(20_000),
      { rejectOnInputError: true },
    )
    expect(result).toEqual([])
  })

  test('a valid matching pattern still returns results with the flag on', async () => {
    const result = await ripGrep(['hello'], dir, AbortSignal.timeout(20_000), {
      rejectOnInputError: true,
    })
    expect(result.some(line => line.includes('hello world'))).toBe(true)
  })
})
