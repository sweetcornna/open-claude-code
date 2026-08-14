import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

import { setupConfigMock } from '../../../../tests/mocks/config.js'
import { PROMPT_CACHE_1H_DEFAULT_ALLOWLIST } from '../../api/promptCacheTTL.js'
import { DEFAULT_SESSION_MEMORY_CONFIG } from '../../SessionMemory/sessionMemoryUtils.js'
import {
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getDynamicConfig_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../growthbook.js'

/**
 * Companion to reactiveOnlyGate.test.ts. `tengu_cobalt_raccoon` was one entry
 * in a 491-gate first-party payload sitting in a real ~/.occ.json; this file
 * pins the rest of that audit.
 *
 * The payload was NOT migrated from ~/.claude (migrateFromClaude.ts copies only
 * mcpServers/env/account keys). occ wrote it itself, after every successful
 * GrowthBook fetch, while holding Anthropic auth — and nothing ever removed it,
 * since logout reset only the in-memory map. So one signed-in session left
 * every unpinned gate answering from a frozen Anthropic experiment assignment
 * forever.
 *
 * That is now closed on three fronts: the fetch is opt-in
 * (OCC_ENABLE_GROWTHBOOK), no payload is written to disk, and logout plus a
 * startup purge remove what earlier versions left behind. These pins remain
 * load-bearing for opted-in users and for self-hosted GrowthBook adapters,
 * which is the configuration this file forces (see beforeAll).
 *
 * CACHED_PAYLOAD is verbatim from that machine.
 */
const CACHED_PAYLOAD: Record<string, unknown> = {
  tengu_ultraplan_config: { enabled: false },
  tengu_sm_config: {
    minimumMessageTokensToInit: 150000,
    minimumTokensBetweenUpdate: 40000,
    toolCallsBetweenUpdates: 10,
  },
  tengu_prompt_cache_1h_config: {
    allowlist: [
      'repl_main_thread*',
      'sdk',
      'auto_mode',
      'rolling_compact',
      'memdir_relevance',
      'agent_classifier',
      'prompt_suggestion',
      'away_summary',
      'extract_memories',
    ],
  },
  'tengu-top-of-feed-tip': { tip: '', color: '' },
  tengu_desktop_upsell: {
    enable_shortcut_tip: true,
    enable_startup_dialog: false,
  },
  tengu_1p_event_batch_config: {
    scheduledDelayMillis: 10000,
    maxExportBatchSize: 400,
    maxQueueSize: 8192,
    path: '/api/event_logging/v2/batch',
  },
  tengu_surreal_dali: true,
  tengu_cobalt_lantern: true,
  tengu_cork_m4q: true,
  tengu_lapis_finch: true,
  tengu_plum_vx3: true,
  tengu_plugin_official_mkt_git_fallback: true,
  tengu_bramble_lintel: 7,
}

const configMock = setupConfigMock()

const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'CLAUDE_GB_ADAPTER_URL',
  'CLAUDE_GB_ADAPTER_KEY',
  'CLAUDE_CODE_DISABLE_LOCAL_GATES',
  'USER_TYPE',
] as const

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  // Force isGrowthBookEnabled() true so the disk-cache branch is live.
  process.env.CLAUDE_GB_ADAPTER_URL = 'https://gb.example.invalid'
  process.env.CLAUDE_GB_ADAPTER_KEY = 'test-key'
  delete process.env.CLAUDE_CODE_DISABLE_LOCAL_GATES
  delete process.env.USER_TYPE

  configMock.set({
    getGlobalConfig: () =>
      ({ cachedGrowthBookFeatures: CACHED_PAYLOAD }) as unknown as ReturnType<
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

describe('cached first-party payload containment', () => {
  test('/ultraplan stays available (cache serves { enabled: false })', () => {
    expect(
      getFeatureValue_CACHED_MAY_BE_STALE<{ enabled: boolean } | null>(
        'tengu_ultraplan_config',
        { enabled: true },
      )?.enabled,
    ).toBe(true)
  })

  test('session-memory thresholds match occ defaults, not the 150k cache', () => {
    // The cache would raise minimumMessageTokensToInit 15x, defeating the
    // tengu_session_memory pin that sits three lines above it.
    expect(getDynamicConfig_CACHED_MAY_BE_STALE('tengu_sm_config', {})).toEqual(
      DEFAULT_SESSION_MEMORY_CONFIG,
    )
  })

  test('1h prompt-cache allowlist matches PROMPT_CACHE_1H_DEFAULT_ALLOWLIST', () => {
    // The cached list drops 'compact' and 'agent:*' and adds exactly the
    // short-lived forked sources promptCacheTTL.ts says must stay out.
    expect(
      getFeatureValue_CACHED_MAY_BE_STALE<{ allowlist?: string[] }>(
        'tengu_prompt_cache_1h_config',
        {},
      ).allowlist,
    ).toEqual([...PROMPT_CACHE_1H_DEFAULT_ALLOWLIST])
  })

  test('no remote-authored banner is rendered above the feed', () => {
    expect(
      getDynamicConfig_CACHED_MAY_BE_STALE('tengu-top-of-feed-tip', {
        tip: '',
        color: '',
      }),
    ).toEqual({ tip: '', color: '' })
  })

  test('the Claude Desktop upsell stays fully off', () => {
    expect(
      getDynamicConfig_CACHED_MAY_BE_STALE('tengu_desktop_upsell', {}),
    ).toEqual({ enable_shortcut_tip: false, enable_startup_dialog: false })
  })

  test('the 1P exporter cannot be retargeted by a served config', () => {
    // baseUrl / path / skipAuth / maxAttempts are all honoured verbatim by
    // FirstPartyEventLoggingExporter's constructor.
    const config = getDynamicConfig_CACHED_MAY_BE_STALE<
      Record<string, unknown>
    >('tengu_1p_event_batch_config', {})
    expect(config).toEqual({})
    expect(config.baseUrl).toBeUndefined()
    expect(config.path).toBeUndefined()
    expect(config.skipAuth).toBeUndefined()
  })

  test.each([
    ['tengu_surreal_dali'],
    ['tengu_cobalt_lantern'],
    ['tengu_cork_m4q'],
    ['tengu_lapis_finch'],
    ['tengu_plum_vx3'],
  ])('%s stays at its call-site default of false', gate => {
    expect(getFeatureValue_CACHED_MAY_BE_STALE(gate, false)).toBe(false)
  })

  test('the computer-use MCP is not auto-registered', () => {
    // Deliberate departure from "restore occ's own call-site default": that
    // default is { enabled: true } (utils/computerUse/gates.ts:14), and occ
    // has hardcoded hasRequiredSubscription() to true, so nothing else stands
    // between a served value and an auto-registered MCP server that can take
    // screenshots and drive the mouse and keyboard.
    expect(
      getDynamicConfig_CACHED_MAY_BE_STALE<{ enabled?: boolean }>(
        'tengu_malort_pedway',
        { enabled: true },
      ).enabled,
    ).toBe(false)
  })

  test('auto-memory extraction keeps the 7-turn cadence, not the code default of 1', () => {
    // Also not the call-site default (`?? 1`). Each extraction forks the full
    // message history; per-turn forking is the residency pattern in
    // docs/zh/features/memory-footprint.md. Determinism beats fidelity here.
    expect(
      getFeatureValue_CACHED_MAY_BE_STALE<number | null>(
        'tengu_bramble_lintel',
        null,
      ),
    ).toBe(7)
  })

  test('the official-marketplace git fallback kill switch stays true', () => {
    expect(
      getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_plugin_official_mkt_git_fallback',
        true,
      ),
    ).toBe(true)
  })

  test('unpinned gates still resolve from the disk cache', () => {
    configMock.set({
      getGlobalConfig: () =>
        ({
          cachedGrowthBookFeatures: {
            ...CACHED_PAYLOAD,
            tengu_some_unpinned_gate: true,
          },
        }) as unknown as ReturnType<
          typeof import('src/utils/config/config.js').getGlobalConfig
        >,
    })
    expect(
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_some_unpinned_gate', false),
    ).toBe(true)
  })

  /**
   * Known hole, asserted so a future change to the priority chain shows up as
   * a failing test rather than a silent behaviour change.
   *
   * checkStatsigFeatureGate_CACHED_MAY_BE_STALE consults LOCAL_GATE_DEFAULTS
   * only after BOTH caches miss, so pinning a gate read through it does
   * nothing. Same for checkSecurityRestrictionGate (never reads local
   * defaults) and getFeatureValue_DEPRECATED / getDynamicConfig_BLOCKS_ON_INIT
   * (skip local defaults whenever GrowthBook is enabled). Gates read only
   * through those must not be added to LOCAL_GATE_DEFAULTS expecting
   * containment.
   */
  test('Statsig-shaped reads are NOT covered by LOCAL_GATE_DEFAULTS', () => {
    configMock.set({
      getGlobalConfig: () =>
        ({
          cachedGrowthBookFeatures: { tengu_plum_vx3: true },
        }) as unknown as ReturnType<
          typeof import('src/utils/config/config.js').getGlobalConfig
        >,
    })
    // Pinned false above, yet the Statsig-shaped reader still answers true.
    expect(getFeatureValue_CACHED_MAY_BE_STALE('tengu_plum_vx3', false)).toBe(
      false,
    )
    expect(checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_plum_vx3')).toBe(
      true,
    )
  })
})
