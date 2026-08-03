import { describe, expect, test } from 'bun:test'
import { consumeRawReadResult } from '../settings'

function registryOutput(json: string): string {
  return `\n    Settings    REG_SZ    ${json}\n`
}

describe('consumeRawReadResult', () => {
  test('keeps invalid managed plist schema errors instead of falling through', () => {
    const result = consumeRawReadResult({
      plistStdouts: [{ stdout: '{"model":123}', label: 'managed preferences' }],
      hklmStdout: null,
      hkcuStdout: registryOutput('{"model":"sonnet"}'),
    })

    expect(result.mdm.sourceExists).toBe(true)
    expect(result.mdm.errors.some(error => error.path === 'model')).toBe(true)
    expect(result.hkcu.sourceExists).toBe(false)
    expect(result.hkcu.settings).toEqual({})
  })

  test('keeps malformed HKLM policy errors and blocks HKCU fallback', () => {
    const result = consumeRawReadResult({
      plistStdouts: null,
      hklmStdout: registryOutput('{"model":'),
      hkcuStdout: registryOutput('{"model":"sonnet"}'),
    })

    expect(result.mdm.sourceExists).toBe(true)
    expect(result.mdm.settings).toEqual({})
    expect(result.mdm.errors).toHaveLength(1)
    expect(result.mdm.errors[0]?.message).toBe('Invalid or malformed JSON')
    expect(result.hkcu.sourceExists).toBe(false)
    expect(result.hkcu.settings).toEqual({})
  })

  test('keeps schema errors from HKLM and blocks HKCU fallback', () => {
    const result = consumeRawReadResult({
      plistStdouts: null,
      hklmStdout: registryOutput('{"model":123}'),
      hkcuStdout: registryOutput('{"model":"sonnet"}'),
    })

    expect(result.mdm.sourceExists).toBe(true)
    expect(result.mdm.errors.some(error => error.path === 'model')).toBe(true)
    expect(result.hkcu.sourceExists).toBe(false)
    expect(result.hkcu.settings).toEqual({})
  })
})
