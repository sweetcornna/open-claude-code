import { expect, mock, test } from 'bun:test'
import type { Entry } from '../../../types/logs.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const { Project } = await import('../transcriptWriter.js')

type ProjectQueueInternals = {
  FLUSH_INTERVAL_MS: number
  appendToFile(filePath: string, data: string): Promise<void>
  enqueueWrite(filePath: string, entry: Entry): Promise<void>
}

test('failed timer drains requeue the batch in order and retry without an unhandled rejection', async () => {
  const project = new Project()
  const internals = project as unknown as ProjectQueueInternals
  const writes: string[] = []
  let attempts = 0

  internals.FLUSH_INTERVAL_MS = 1
  internals.appendToFile = async (_filePath, data) => {
    attempts++
    if (attempts === 1) throw new Error('disk temporarily unavailable')
    writes.push(data)
  }

  const first = internals.enqueueWrite('/unused/transcript.jsonl', {
    type: 'custom-title',
    customTitle: 'first',
    sessionId: '11111111-1111-4111-8111-111111111111',
  } as unknown as Entry)
  const second = internals.enqueueWrite('/unused/transcript.jsonl', {
    type: 'custom-title',
    customTitle: 'second',
    sessionId: '11111111-1111-4111-8111-111111111111',
  } as unknown as Entry)

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all([first, second]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('drain retry timed out')),
          1000,
        )
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    project._resetFlushState()
  }

  expect(attempts).toBe(2)
  expect(writes).toHaveLength(1)
  expect(writes[0]).toContain('"customTitle":"first"')
  expect(writes[0]).toContain('"customTitle":"second"')
  expect(writes[0]!.indexOf('first')).toBeLessThan(writes[0]!.indexOf('second'))
})
