import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  cleanupTempDir,
  createTempDir,
} from '../../../../tests/mocks/file-system.js'
import {
  createAutonomyQueuedPrompt,
  getAutonomyRunById,
} from '../../../utils/agents/autonomyRuns.js'
import { QueryGuard } from '../../../utils/session/QueryGuard.js'
import {
  getCommandQueue,
  resetCommandQueue,
} from '../../../utils/session/messageQueueManager.js'
import { runIncomingPrompt } from '../runIncomingPrompt.js'

async function waitFor(
  condition: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition was not reached')
}

describe('runIncomingPrompt', () => {
  let tempDir = ''

  beforeEach(async () => {
    resetCommandQueue()
    tempDir = await createTempDir('run-incoming-prompt-')
  })

  afterEach(async () => {
    resetCommandQueue()
    if (tempDir) await cleanupTempDir(tempDir)
  })

  test('reserves the query guard before autonomy claim yields', async () => {
    const queryGuard = new QueryGuard()
    let queryCalls = 0

    const accepted = runIncomingPrompt('scheduled work', undefined, {
      mainLoopModel: 'test-model',
      queryGuard,
      setAbortController: () => {},
      onQuery: async () => {
        queryCalls++
        const generation = queryGuard.tryStart()
        expect(generation).not.toBeNull()
        queryGuard.end(generation!)
        return true
      },
    })

    expect(accepted).toBe(true)
    expect(queryGuard.isActive).toBe(true)

    await waitFor(() => queryCalls === 1 && !queryGuard.isActive)
  })

  test('requeues an unexecuted meta command without losing metadata', async () => {
    const queryGuard = new QueryGuard()
    let queryCalls = 0
    const command = {
      value: '<tick>continue</tick>',
      mode: 'prompt' as const,
      isMeta: true,
      priority: 'later' as const,
    }

    expect(
      runIncomingPrompt(command, undefined, {
        mainLoopModel: 'test-model',
        queryGuard,
        setAbortController: () => {},
        onQuery: async () => {
          queryCalls++
          return false
        },
      }),
    ).toBe(true)

    queryGuard.forceEnd()
    const competingGeneration = queryGuard.tryStart()
    expect(competingGeneration).not.toBeNull()

    await waitFor(() => getCommandQueue().length === 1)
    expect(getCommandQueue()[0]).toMatchObject(command)
    expect(queryCalls).toBe(0)

    queryGuard.end(competingGeneration!)
  })

  test('cancels a claimed autonomy run when its query never executes', async () => {
    const command = await createAutonomyQueuedPrompt({
      basePrompt: 'scheduled work',
      trigger: 'scheduled-task',
      rootDir: tempDir,
      currentDir: tempDir,
    })
    expect(command).not.toBeNull()

    const queryGuard = new QueryGuard()
    let queryCalls = 0
    expect(
      runIncomingPrompt(command!, undefined, {
        mainLoopModel: 'test-model',
        queryGuard,
        setAbortController: () => {},
        onQuery: async () => {
          queryCalls++
          return false
        },
      }),
    ).toBe(true)

    queryGuard.forceEnd()
    const competingGeneration = queryGuard.tryStart()
    expect(competingGeneration).not.toBeNull()

    let status: string | undefined
    await waitFor(async () => {
      const run = await getAutonomyRunById(command!.autonomy!.runId, tempDir)
      status = run?.status
      return status === 'cancelled'
    })
    expect(status).toBe('cancelled')
    expect(getCommandQueue()).toHaveLength(0)
    expect(queryCalls).toBe(0)

    queryGuard.end(competingGeneration!)
  })
})
