import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { occConfigDir } from '../../../config/paths.js'
import {
  clearApiKeyHelperCache,
  getApiKeyFromApiKeyHelper,
  getApiKeyHelperError,
} from '../auth.js'
import { getSettingsFilePathForSource } from '../../settings/settings.js'
import { resetSettingsCache } from '../../settings/settingsCache.js'

const originalConfigDir = process.env.OCC_CONFIG_DIR
let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-api-key-helper-error-'))
  process.env.OCC_CONFIG_DIR = tempDir
  occConfigDir.cache.clear?.()
  resetSettingsCache()
  clearApiKeyHelperCache()
})

afterEach(() => {
  clearApiKeyHelperCache()
  resetSettingsCache()
  if (originalConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = originalConfigDir
  occConfigDir.cache.clear?.()
  rmSync(tempDir, { recursive: true, force: true })
})

function configureApiKeyHelper(command: string): void {
  const settingsPath = getSettingsFilePathForSource('userSettings')
  if (!settingsPath) throw new Error('user settings path is unavailable')
  writeFileSync(settingsPath, JSON.stringify({ apiKeyHelper: command }))
  resetSettingsCache()
}

describe('apiKeyHelper error lifecycle', () => {
  test('clear removes an error recorded by a failed helper', async () => {
    const helper = join(tempDir, 'failing-helper.sh')
    writeFileSync(helper, '#!/bin/sh\necho "reauth required" >&2\nexit 7\n')
    chmodSync(helper, 0o755)
    configureApiKeyHelper(helper)

    expect(await getApiKeyFromApiKeyHelper(true)).toBe(' ')
    expect(getApiKeyHelperError()).toContain('reauth required')

    clearApiKeyHelperCache()

    expect(getApiKeyHelperError()).toBeNull()
  })

  test('returns null when apiKeyHelper is not configured', () => {
    expect(getApiKeyHelperError()).toBeNull()
  })
})
