import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { getFirstWordPrefix } = await import('../bashPermissions.js')

describe('exec-wrapper prefixes are never suggested as rules', () => {
  test('watch/ionice/setsid rejected like nice/timeout (2.1.113 parity)', () => {
    // A `Bash(watch:*)` rule would be ≈ Bash(*): the wrapper execs its
    // argument, so the wrapped command escapes prefix matching entirely.
    for (const wrapper of ['watch', 'ionice', 'setsid', 'nice', 'timeout']) {
      expect(getFirstWordPrefix(`${wrapper} rm -rf /`)).toBeNull()
    }
  })

  test('ordinary commands still produce a first-word prefix', () => {
    expect(getFirstWordPrefix('git status')).toBe('git')
    expect(getFirstWordPrefix('cargo build --release')).toBe('cargo')
  })
})
