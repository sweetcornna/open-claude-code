import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

import {
  _writeCacheBreakDiffForTesting,
  resetPromptCacheBreakDetection,
} from '../promptCacheBreakDetection.js'

let tempRoot = ''

beforeEach(async () => {
  resetPromptCacheBreakDetection()
  tempRoot = await mkdtemp(join(tmpdir(), 'occ-cache-break-test-'))
})

afterEach(async () => {
  resetPromptCacheBreakDetection()
  await rm(tempRoot, { recursive: true, force: true })
})

describe('prompt cache break diagnostics', () => {
  test('writes only redacted content into a private session directory', async () => {
    const oldSecret = 'SYSTEM_SECRET=old-sensitive-instruction'
    const newSecret = 'SYSTEM_SECRET=new-sensitive-instruction'
    const toolSecret = '{"api_key":"tool-schema-secret"}'
    const diffPath = await _writeCacheBreakDiffForTesting(
      `${oldSecret}\n${toolSecret}`,
      `${newSecret}\n${toolSecret}`,
      tempRoot,
    )

    expect(diffPath).toBeDefined()
    const sessionDir = dirname(diffPath!)
    const directoryMode = (await stat(sessionDir)).mode & 0o777
    const fileMode = (await stat(diffPath!)).mode & 0o777
    const contents = await readFile(diffPath!, 'utf8')

    expect(dirname(sessionDir)).toBe(tempRoot)
    expect(basename(sessionDir)).toStartWith('cache-break-')
    expect(directoryMode).toBe(0o700)
    expect(fileMode).toBe(0o600)
    expect(contents).toContain('[redacted chars=')
    expect(contents).not.toContain(oldSecret)
    expect(contents).not.toContain(newSecret)
    expect(contents).not.toContain(toolSecret)

    resetPromptCacheBreakDetection()
    expect(await stat(sessionDir).catch(() => null)).toBeNull()
  })
})
