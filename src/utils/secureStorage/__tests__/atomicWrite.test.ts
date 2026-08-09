import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  writePrivateFileAtomic,
  writePrivateFileAtomicSync,
} from '../atomicWrite.js'

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('writePrivateFileAtomic', () => {
  for (const [label, write] of [
    ['async', writePrivateFileAtomic],
    [
      'sync',
      async (filePath: string, content: string) =>
        writePrivateFileAtomicSync(filePath, content),
    ],
  ] as const) {
    test(`${label} replacement preserves private permissions`, async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'occ-private-write-'))
      const filePath = join(tempDir, 'credential.json')
      await writeFile(filePath, 'old credential', { mode: 0o644 })

      await write(filePath, 'new credential')

      expect(await readFile(filePath, 'utf8')).toBe('new credential')
      if (process.platform !== 'win32') {
        expect((await stat(filePath)).mode & 0o777).toBe(0o600)
      }
      expect(await readdir(tempDir)).toEqual(['credential.json'])
    })
  }
})
