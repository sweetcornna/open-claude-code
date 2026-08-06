import { describe, expect, test } from 'bun:test'
import {
  isSafeVersionSpec,
  packageManagerSpawnOptions,
} from '../packageManager.js'

describe('isSafeVersionSpec', () => {
  test.each([
    '1.2.3',
    '2.0.0-beta.1',
    '1.0.0+build.5',
    'latest',
    'next',
    '0',
  ])('accepts %s', spec => {
    expect(isSafeVersionSpec(spec)).toBe(true)
  })

  test.each([
    '1.0.0 & calc',
    '1.0.0&&whoami',
    '1.0.0 | more',
    '1.0.0; rm -rf /',
    '$(id)',
    '`id`',
    '1.0.0 > out.txt',
    '../../etc/passwd',
    '-1.0.0',
    '.1.0.0',
    '',
    'a b',
    '1.0.0\nnext',
  ])('rejects %j', spec => {
    // These reach cmd.exe on Windows, where the shell option is required to
    // start npm at all — see packageManagerSpawnOptions.
    expect(isSafeVersionSpec(spec)).toBe(false)
  })
})

describe('packageManagerSpawnOptions', () => {
  test('always hides the console window', () => {
    expect(packageManagerSpawnOptions().windowsHide).toBe(true)
  })

  test('uses a shell only on Windows, where npm is a .cmd shim', () => {
    expect(packageManagerSpawnOptions().shell).toBe(
      process.platform === 'win32',
    )
  })
})
