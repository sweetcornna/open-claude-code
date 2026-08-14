import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import * as realCompact from 'src/services/compact/compact.js'
import * as realSessionMemoryCompact from 'src/services/compact/sessionMemoryCompact.js'
import { setupConfigMock } from '../../../../tests/mocks/config.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'
import type { Message } from '../../../types/message.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { CacheSafeParams } from '../../../utils/agents/forkedAgent.js'
import { autoCompactIfNeeded } from '../autoCompact.js'

/**
 * The autocompact circuit breaker stops retrying after 3 consecutive failures,
 * because a context that is irrecoverably over the limit would otherwise
 * hammer the API on every turn (BQ: ~250K wasted calls/day).
 *
 * It is a one-way door: the ONLY reset is a *successful* compaction, and an
 * open breaker returns before it can attempt one. So anything that feeds the
 * counter without being a real "this can never be compacted" signal disables
 * automatic compaction for the rest of the turn. Three seconds of flaky
 * network used to be enough — the user's transcript shows ECONNRESET,
 * stream_read_error and ENOTFOUND inside one turn.
 *
 * Transient failures must therefore not count. The classification is the
 * provider-agnostic one from retryClassification.ts, so this holds for every
 * provider rather than for Anthropic wording only.
 *
 *   effectiveWindow      = 100_000 - 20_000 = 80_000
 *   autoCompactThreshold = 80_000 - 13_000  = 67_000
 *
 * An 80_000-token anchor is therefore above the threshold: shouldAutoCompact
 * says yes, compactConversation throws, and the return value tells us whether
 * the breaker was fed.
 */

const compactMock = makeSharedModuleMock(
  'src/services/compact/compact.js',
  realCompact,
)
const sessionMemoryMock = makeSharedModuleMock(
  'src/services/compact/sessionMemoryCompact.js',
  realSessionMemoryCompact,
)

const compactControls = compactMock.setup()
const sessionMemoryControls = sessionMemoryMock.setup()
const configControls = setupConfigMock()

const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
] as const

let thrown: unknown = new Error('boom')

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '100000'
  delete process.env.DISABLE_COMPACT
  delete process.env.DISABLE_AUTO_COMPACT

  configControls.set({
    getGlobalConfig: () =>
      ({ autoCompactEnabled: true }) as ReturnType<
        typeof import('src/utils/config/config.js').getGlobalConfig
      >,
  })
  sessionMemoryControls.set({
    trySessionMemoryCompaction: async () => null,
  })
  compactControls.set({
    compactConversation: async () => {
      throw thrown
    },
  })
})

afterAll(() => {
  compactControls.reset()
  sessionMemoryControls.reset()
  configControls.reset()
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** An assistant record whose API-reported usage is the estimation anchor. */
function anchor(totalTokens: number): Message {
  return {
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-000000000001',
    timestamp: '2026-01-01T00:00:00.000Z',
    message: {
      id: 'msg_anchor',
      role: 'assistant',
      model: 'gpt-5.6-sol',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: totalTokens,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  } as unknown as Message
}

const toolUseContext = {
  agentId: undefined,
  options: {
    mainLoopModel: 'gpt-5.6-sol',
    modelSettingsSlot: undefined,
    sessionModelSettingsOverrides: undefined,
    autoCompactWindow: undefined,
    autoCompactWindowOverride: undefined,
  },
} as unknown as ToolUseContext

const cacheSafeParams = {} as unknown as CacheSafeParams

async function runWith(error: unknown, consecutiveFailures = 0) {
  thrown = error
  return autoCompactIfNeeded(
    [anchor(80_000)],
    toolUseContext,
    cacheSafeParams,
    'repl_main_thread',
    {
      compacted: false,
      turnId: 'turn-1',
      turnCounter: 0,
      consecutiveFailures,
    },
  )
}

describe('autocompact circuit breaker', () => {
  test('a deterministic failure counts toward the breaker', async () => {
    const result = await runWith(
      new APIError(
        400,
        { error: { message: 'prompt is too long: 400000 tokens > 200000' } },
        'prompt is too long: 400000 tokens > 200000',
        undefined,
      ),
    )
    expect(result.wasCompacted).toBe(false)
    expect(result.consecutiveFailures).toBe(1)
  })

  test('a dropped socket does not count toward the breaker', async () => {
    const cause = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    })
    const result = await runWith(new APIConnectionError({ cause }))
    expect(result.wasCompacted).toBe(false)
    // undefined = "declined, nothing to record"; recordCompactionFailure in
    // query.ts leaves the tracking state untouched for this value.
    expect(result.consecutiveFailures).toBeUndefined()
  })

  test('a 5xx from the provider does not count toward the breaker', async () => {
    const result = await runWith(
      new APIError(503, undefined, 'Service Unavailable', undefined),
    )
    expect(result.wasCompacted).toBe(false)
    expect(result.consecutiveFailures).toBeUndefined()
  })

  test('a user abort does not count toward the breaker', async () => {
    const result = await runWith(
      new Error(realCompact.ERROR_MESSAGE_USER_ABORT),
    )
    expect(result.wasCompacted).toBe(false)
    expect(result.consecutiveFailures).toBeUndefined()
  })

  test('a flaky stretch cannot open the breaker on its own', async () => {
    let failures = 0
    for (const error of [
      new APIConnectionError({
        cause: Object.assign(new Error('socket hang up'), {
          code: 'ECONNRESET',
        }),
      }),
      new APIError(503, undefined, 'Service Unavailable', undefined),
      new APIConnectionError({
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND gw.example'), {
          code: 'ENOTFOUND',
        }),
      }),
    ]) {
      const result = await runWith(error, failures)
      failures = result.consecutiveFailures ?? failures
    }
    expect(failures).toBe(0)
  })

  test('the breaker still short-circuits once it is open', async () => {
    thrown = new Error('should never be thrown — compaction must not be tried')
    const result = await autoCompactIfNeeded(
      [anchor(80_000)],
      toolUseContext,
      cacheSafeParams,
      'repl_main_thread',
      {
        compacted: false,
        turnId: 'turn-1',
        turnCounter: 0,
        consecutiveFailures: 3,
      },
    )
    expect(result).toEqual({ wasCompacted: false })
  })
})
