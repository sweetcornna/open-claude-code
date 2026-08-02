import { expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  CLIPBOARD_TEMP_PREFIX,
  generateTempFilePath,
  SESSION_EXPORT_FILENAME,
  SETTINGS_TEMP_PREFIX,
  SHARE_TEMP_PREFIX,
  TRANSCRIPT_TEMP_PREFIX,
} from '../filesystem/tempfile.js'

test('default prompt paths use the occ namespace and do not collide', () => {
  const first = generateTempFilePath()
  const second = generateTempFilePath()

  expect(first).not.toBe(second)
  expect(first).toMatch(/[/\\]occ-prompt-[0-9a-f-]+\.md$/)
  expect(second).toMatch(/[/\\]occ-prompt-[0-9a-f-]+\.md$/)
})

test('settings paths are deterministic within the occ namespace', () => {
  const options = { contentHash: '{"model":"sonnet"}' }
  const first = generateTempFilePath(SETTINGS_TEMP_PREFIX, '.json', options)
  const second = generateTempFilePath(SETTINGS_TEMP_PREFIX, '.json', options)
  const different = generateTempFilePath(SETTINGS_TEMP_PREFIX, '.json', {
    contentHash: '{"model":"opus"}',
  })

  expect(first).toBe(second)
  expect(first).not.toBe(different)
  expect(first).toMatch(/[/\\]occ-settings-[0-9a-f]{16}\.json$/)
})

test('clipboard paths use the requested directory and do not collide', () => {
  const tempDirectory = join('test-root', 'clipboard')
  const first = generateTempFilePath(CLIPBOARD_TEMP_PREFIX, '.png', {
    tempDirectory,
  })
  const second = generateTempFilePath(CLIPBOARD_TEMP_PREFIX, '.png', {
    tempDirectory,
  })

  expect(first).not.toBe(second)
  expect(
    first.startsWith(`${tempDirectory}/`) ||
      first.startsWith(`${tempDirectory}\\`),
  ).toBe(true)
  expect(first).toMatch(/[/\\]occ-clipboard-[0-9a-f-]+\.png$/)
})

test('share and transcript files use isolated occ identities', () => {
  const first = generateTempFilePath(TRANSCRIPT_TEMP_PREFIX, '.txt')
  const second = generateTempFilePath(TRANSCRIPT_TEMP_PREFIX, '.txt')

  expect(first).not.toBe(second)
  expect(first).toMatch(/[/\\]occ-transcript-[0-9a-f-]+\.txt$/)
  expect(SHARE_TEMP_PREFIX).toBe('occ-share')
  expect(SESSION_EXPORT_FILENAME).toBe('occ-session.jsonl')
})
