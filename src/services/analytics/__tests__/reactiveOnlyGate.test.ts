import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

import { setupConfigMock } from '../../../../tests/mocks/config.js'
import { shouldAutoCompact } from '../../compact/autoCompact.js'
import type { Message } from '../../../types/message.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../growthbook.js'

/**
 * `tengu_cobalt_raccoon` is the reactive-only compaction arm: when it is on,
 * shouldAutoCompact returns false on every turn and the API's prompt-too-long
 * error is the only thing that ever triggers a compact.
 *
 * occ installs carry a cached first-party GrowthBook payload (491 gates,
 * migrated from ~/.claude or fetched while signed in) in which this gate is
 * TRUE. Once REACTIVE_COMPACT entered the default build in v2.42.0, that
 * cached value silently disabled proactive autocompact for those users, and
 * the reactive half could not cover for it on a third-party gateway whose
 * overflow wording occ did not recognise.
 *
 * LOCAL_GATE_DEFAULTS exists precisely to stop a remote payload from steering
 * a fork; this pins the gate off so the cached `true` can never win again.
 */
const configMock = setupConfigMock()

const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'CLAUDE_GB_ADAPTER_URL',
  'CLAUDE_GB_ADAPTER_KEY',
  'CLAUDE_CODE_DISABLE_LOCAL_GATES',
  'USER_TYPE',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'DISABLE_COMPACT',
  'DISABLE_AUTO_COMPACT',
] as const

/**
 * An assistant record whose API-reported usage is the estimation anchor.
 * With CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000 the autocompact threshold is
 * 100_000 - 20_000 - 13_000 = 67_000, so 80_000 is comfortably over it.
 */
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

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  // Force isGrowthBookEnabled() true so the disk-cache branch is live — that
  // is the branch the outage went through.
  process.env.CLAUDE_GB_ADAPTER_URL = 'https://gb.example.invalid'
  process.env.CLAUDE_GB_ADAPTER_KEY = 'test-key'
  delete process.env.CLAUDE_CODE_DISABLE_LOCAL_GATES
  delete process.env.USER_TYPE
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '100000'
  delete process.env.DISABLE_COMPACT
  delete process.env.DISABLE_AUTO_COMPACT

  configMock.set({
    getGlobalConfig: () =>
      ({
        // Exactly what the affected users had on disk: autoCompactEnabled
        // absent (defaulted true by config.ts) and the reactive-only gate
        // cached true from a first-party payload.
        autoCompactEnabled: true,
        cachedGrowthBookFeatures: { tengu_cobalt_raccoon: true },
      }) as unknown as ReturnType<
        typeof import('src/utils/config/config.js').getGlobalConfig
      >,
  })
})

afterAll(() => {
  configMock.reset()
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('reactive-only compaction gate', () => {
  test('stays off even when the cached GrowthBook payload turns it on', () => {
    expect(
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false),
    ).toBe(false)
  })

  test('the disk cache is otherwise still honoured for unpinned gates', () => {
    configMock.set({
      getGlobalConfig: () =>
        ({
          cachedGrowthBookFeatures: {
            tengu_cobalt_raccoon: true,
            tengu_some_unpinned_gate: true,
          },
        }) as unknown as ReturnType<
          typeof import('src/utils/config/config.js').getGlobalConfig
        >,
    })

    expect(
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_some_unpinned_gate', false),
    ).toBe(true)
    expect(
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_raccoon', false),
    ).toBe(false)
  })

  /**
   * End-to-end form of the same guarantee, in the exact machine shape that
   * produced the outage.
   *
   * NOTE: this assertion only exercises the reactive-only branch when the
   * REACTIVE_COMPACT feature is compiled in. Plain `bun test` builds it out
   * (feature() is false), so run
   *
   *   bun test --feature REACTIVE_COMPACT <this file>
   *
   * to reproduce the failure this pins. It is kept in the default suite
   * because it must also hold for builds that ship the flag.
   */
  test('proactive autocompact still fires over the threshold', async () => {
    configMock.set({
      getGlobalConfig: () =>
        ({
          autoCompactEnabled: true,
          cachedGrowthBookFeatures: { tengu_cobalt_raccoon: true },
        }) as unknown as ReturnType<
          typeof import('src/utils/config/config.js').getGlobalConfig
        >,
    })

    await expect(
      shouldAutoCompact(
        [anchor(80_000)],
        'gpt-5.6-sol',
        'repl_main_thread' as Parameters<typeof shouldAutoCompact>[2],
      ),
    ).resolves.toBe(true)
  })
})
