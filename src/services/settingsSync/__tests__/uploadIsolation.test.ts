import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import {
  downloadUserSettings,
  redownloadUserSettings,
  uploadUserSettingsInBackground,
} from '../index.js'

describe('settings sync isolation', () => {
  test('keeps all remote synchronization disabled', async () => {
    await expect(uploadUserSettingsInBackground()).resolves.toBeUndefined()
    await expect(downloadUserSettings()).resolves.toBe(false)
    await expect(redownloadUserSettings()).resolves.toBe(false)
  })

  test('contains no official endpoint or network/file mutation capability', async () => {
    const source = await readFile(
      new URL('../index.ts', import.meta.url),
      'utf8',
    )

    expect(source).not.toContain('/api/claude_code/user_settings')
    expect(source).not.toContain("from 'axios'")
    expect(source).not.toContain('axios.get')
    expect(source).not.toContain('axios.put')
    expect(source).not.toContain("from 'fs/promises'")
    expect(source).not.toContain('writeFile(')
  })
})
