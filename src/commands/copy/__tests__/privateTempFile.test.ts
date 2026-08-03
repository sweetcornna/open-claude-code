import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  cleanupCopyTempDirs,
  writeToPrivateTempFile,
} from '../privateTempFile.js'

afterEach(() => {
  cleanupCopyTempDirs()
})

describe('/copy private temp files', () => {
  test('uses unique private directories and exclusive 0600 files', async () => {
    const first = await writeToPrivateTempFile('first secret', 'response.md')
    const second = await writeToPrivateTempFile('second secret', 'response.md')

    expect(first).not.toBe(second)
    expect(dirname(first)).not.toBe(dirname(second))
    expect((await stat(dirname(first))).mode & 0o777).toBe(0o700)
    expect((await stat(first)).mode & 0o777).toBe(0o600)
    expect(await readFile(first, 'utf8')).toBe('first secret')
  })

  test('removes private response files when the CLI is finished with them', async () => {
    const filePath = await writeToPrivateTempFile(
      'sensitive output',
      'copy.txt',
    )
    const directory = dirname(filePath)

    cleanupCopyTempDirs()

    expect(existsSync(filePath)).toBe(false)
    expect(existsSync(directory)).toBe(false)
  })
})
