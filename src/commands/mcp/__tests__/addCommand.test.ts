import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { writeHeaderNames } from '../addCommand.js'

afterEach(() => {
  spyOn(process.stdout, 'write').mockRestore()
})

describe('mcp add header output', () => {
  test('prints header names without credential values', () => {
    let stdout = ''
    spyOn(process.stdout, 'write').mockImplementation((chunk => {
      stdout += String(chunk)
      return true
    }) as typeof process.stdout.write)

    writeHeaderNames({
      Authorization: 'Bearer bearer-secret-value',
      'X-API-Key': 'api-key-secret-value',
      'X-Custom': 'non-secret-but-still-private',
    })

    expect(stdout).toContain('Authorization')
    expect(stdout).toContain('X-API-Key')
    expect(stdout).toContain('X-Custom')
    expect(stdout).not.toContain('bearer-secret-value')
    expect(stdout).not.toContain('api-key-secret-value')
    expect(stdout).not.toContain('non-secret-but-still-private')
  })
})
