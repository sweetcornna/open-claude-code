/**
 * `resumeFromRunId` is caller-supplied and becomes a path segment under the
 * runs directory. The store also exposes explicit directory cleanup, so an
 * unvalidated id would be a delete-any-writable-directory primitive. Guarded
 * in two places: the tool schema (first line, gives a clean error) and the
 * store (covers all callers).
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileJournalStore } from '../engine/journal.js'
import { assertValidRunId, isValidRunId } from '../engine/paths.js'
import { workflowInputSchema } from '../tool/schema.js'

const TRAVERSING_IDS = [
  '../escape',
  '../../../etc',
  'a/b',
  'a\\b',
  '.',
  '..',
  '/absolute',
  '',
]

// `generateTaskId` (src/Task.ts) emits a one-letter prefix + 8 chars of [0-9a-z].
const LEGITIMATE_IDS = ['w3k9d0f2a', 'wf_abc123', 'run-1', 'A1']

describe('run id validation', () => {
  test.each(TRAVERSING_IDS)('rejects %j', id => {
    expect(isValidRunId(id)).toBe(false)
    expect(() => assertValidRunId(id)).toThrow(/Invalid workflow run id/)
  })

  test.each(LEGITIMATE_IDS)('accepts %j', id => {
    expect(isValidRunId(id)).toBe(true)
    expect(assertValidRunId(id)).toBe(id)
  })

  test('rejects a null byte', () => {
    expect(isValidRunId('ok\0/../evil')).toBe(false)
  })
})

describe('tool schema guards resumeFromRunId', () => {
  test.each(TRAVERSING_IDS.filter(Boolean))('rejects %j', id => {
    const parsed = workflowInputSchema.safeParse({ resumeFromRunId: id })
    expect(parsed.success).toBe(false)
  })

  test('accepts a generated run id', () => {
    expect(
      workflowInputSchema.safeParse({ resumeFromRunId: 'w3k9d0f2a' }).success,
    ).toBe(true)
  })
})

describe('journal store containment', () => {
  test('truncate cannot delete a directory outside runsDir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wf-runid-'))
    const runsDir = join(root, 'runs')
    const victim = join(root, 'precious')
    mkdirSync(runsDir, { recursive: true })
    mkdirSync(victim, { recursive: true })
    writeFileSync(join(victim, 'data.txt'), 'important')

    const store = createFileJournalStore(runsDir)
    await expect(store.truncate('../precious')).rejects.toThrow(
      /Invalid workflow run id/,
    )
    expect(existsSync(join(victim, 'data.txt'))).toBe(true)
  })

  test('append still works for a legitimate run id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wf-runid-ok-'))
    const runsDir = join(root, 'runs')
    mkdirSync(runsDir, { recursive: true })

    const store = createFileJournalStore(runsDir)
    await store.append('w3k9d0f2a', {
      seq: 0,
      key: 'k',
      result: 'ok',
    } as never)
    expect(existsSync(join(runsDir, 'w3k9d0f2a', 'journal.jsonl'))).toBe(true)
  })
})
