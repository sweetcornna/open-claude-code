import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)

const {
  MODEL_CATALOG_FETCH_TIMEOUT_MS,
  maybeScheduleModelCatalogRefresh,
  refreshModelCatalog,
  resetModelCatalogScheduleForTests,
} = await import('../refresh.js')

const { buildCatalogKey } = await import('../cache.js')

type Deps = import('../refresh.js').RefreshModelCatalogDeps

type Written = { key: string; models: unknown; now: number }

/**
 * The whole flow runs through the injected deps seam (same shape as
 * backgroundOccUpdate.ts), so no process-global mock.module of providers,
 * settings or the network layer is needed.
 */
function makeDeps(overrides: Partial<Deps> = {}): {
  deps: Deps
  writes: Written[]
} {
  const writes: Written[] = []
  const deps: Deps = {
    getProvider: () => 'openai',
    isEssentialTrafficOnly: () => false,
    hasFreshCatalog: () => false,
    fetchModels: async () => [{ id: 'gpt-9' }],
    writeEntry: (key, models, now) => {
      writes.push({ key, models, now })
      return true
    },
    ...overrides,
  }
  return { deps, writes }
}

const savedEnv = {
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  NODE_ENV: process.env.NODE_ENV,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
}

beforeEach(() => {
  process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
  resetModelCatalogScheduleForTests()
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  resetModelCatalogScheduleForTests()
})

describe('refreshModelCatalog', () => {
  test('writes the fetched models under the provider+baseURL key', async () => {
    const { deps, writes } = makeDeps()
    const result = await refreshModelCatalog({ deps, now: 1234 })
    expect(result).toEqual({ status: 'updated', models: [{ id: 'gpt-9' }] })
    expect(writes).toEqual([
      {
        key: buildCatalogKey('openai', 'https://api.openai.com/v1'),
        models: [{ id: 'gpt-9' }],
        now: 1234,
      },
    ])
  })

  test('respects CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', async () => {
    let fetched = false
    const { deps } = makeDeps({
      isEssentialTrafficOnly: () => true,
      fetchModels: async () => {
        fetched = true
        return [{ id: 'gpt-9' }]
      },
    })
    expect(await refreshModelCatalog({ deps })).toEqual({
      status: 'skipped',
      reason: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    })
    expect(fetched).toBe(false)
  })

  test('skips providers without a model-list endpoint', async () => {
    const { deps } = makeDeps({ getProvider: () => 'bedrock' })
    expect(await refreshModelCatalog({ deps })).toEqual({
      status: 'skipped',
      reason: 'unsupported provider: bedrock',
    })
  })

  test('skips the network while the cached entry is still fresh', async () => {
    let fetched = false
    const { deps } = makeDeps({
      hasFreshCatalog: () => true,
      fetchModels: async () => {
        fetched = true
        return [{ id: 'gpt-9' }]
      },
    })
    expect(await refreshModelCatalog({ deps })).toEqual({ status: 'fresh' })
    expect(fetched).toBe(false)
  })

  test('force refetches even with a fresh cache', async () => {
    const { deps } = makeDeps({ hasFreshCatalog: () => true })
    expect(await refreshModelCatalog({ deps, force: true })).toEqual({
      status: 'updated',
      models: [{ id: 'gpt-9' }],
    })
  })

  test('passes an abort signal down to the fetcher', async () => {
    let signal: AbortSignal | undefined
    const { deps } = makeDeps({
      fetchModels: async (_provider, options) => {
        signal = options.signal
        return [{ id: 'gpt-9' }]
      },
    })
    await refreshModelCatalog({ deps })
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
    expect(MODEL_CATALOG_FETCH_TIMEOUT_MS).toBe(5000)
  })

  test('aborts the fetch once the timeout elapses', async () => {
    let aborted = false
    const { deps } = makeDeps({
      fetchModels: (_provider, options) =>
        new Promise(resolve => {
          options.signal.addEventListener('abort', () => {
            aborted = true
            resolve(null)
          })
        }),
    })
    const result = await refreshModelCatalog({ deps, timeoutMs: 1 })
    expect(aborted).toBe(true)
    expect(result).toEqual({ status: 'fetch-failed' })
  })

  test('treats a null or empty fetch result as a failure, not a write', async () => {
    const nullDeps = makeDeps({ fetchModels: async () => null })
    expect(await refreshModelCatalog({ deps: nullDeps.deps })).toEqual({
      status: 'fetch-failed',
    })
    expect(nullDeps.writes).toEqual([])

    const emptyDeps = makeDeps({ fetchModels: async () => [] })
    expect(await refreshModelCatalog({ deps: emptyDeps.deps })).toEqual({
      status: 'fetch-failed',
    })
    expect(emptyDeps.writes).toEqual([])
  })

  test('reports a failed disk write without throwing', async () => {
    const { deps } = makeDeps({ writeEntry: () => false })
    expect(await refreshModelCatalog({ deps })).toEqual({
      status: 'write-failed',
    })
  })

  test('never propagates an exception from the dependency chain', async () => {
    const { deps } = makeDeps({
      getProvider: () => {
        throw new Error('settings blew up')
      },
    })
    expect(await refreshModelCatalog({ deps })).toEqual({
      status: 'fetch-failed',
    })
  })
})

describe('maybeScheduleModelCatalogRefresh', () => {
  test('schedules exactly one run per session', async () => {
    let runs = 0
    const run = async (): Promise<void> => {
      runs += 1
    }
    const env = { NODE_ENV: 'production' } as NodeJS.ProcessEnv
    expect(maybeScheduleModelCatalogRefresh({ env, delayMs: 1, run })).toBe(
      true,
    )
    expect(maybeScheduleModelCatalogRefresh({ env, delayMs: 1, run })).toBe(
      false,
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(runs).toBe(1)
  })

  test('does not schedule under NODE_ENV=test', () => {
    expect(
      maybeScheduleModelCatalogRefresh({
        env: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
        run: async () => {},
      }),
    ).toBe(false)
  })

  test('does not schedule when nonessential traffic is disabled', () => {
    expect(
      maybeScheduleModelCatalogRefresh({
        env: {
          NODE_ENV: 'production',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        } as NodeJS.ProcessEnv,
        run: async () => {},
      }),
    ).toBe(false)
  })

  test('swallows a rejection from the scheduled run', async () => {
    expect(
      maybeScheduleModelCatalogRefresh({
        env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
        delayMs: 1,
        run: async () => {
          throw new Error('boom')
        },
      }),
    ).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
  })
})
