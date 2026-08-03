/**
 * Regression tests for /usage command — v2.1.118 upstream alignment.
 * Verifies:
 *   - /usage is primary command with aliases ["cost", "stats"]
 *   - description covers cost + stats
 *   - availability restriction removed (not claude-ai only)
 *   - cost/stats index files emit commands with matching name
 */

import { mock, describe, test, expect } from 'bun:test'

// Must mock before importing anything that pulls in bootstrap/state
import { logMock } from '../../../../tests/mocks/log.js'
mock.module('src/utils/telemetry/log.ts', logMock)

import { debugMock } from '../../../../tests/mocks/debug.js'
mock.module('src/utils/telemetry/debug.ts', debugMock)

mock.module('bun:bundle', () => ({ feature: () => false }))

// auth via the shared complete-surface mock (missing exports get safe
// defaults); registered under the canonical '.js' specifier so all writers
// hit the same registry entry — see tests/mocks/auth.ts.
import { authMockWith } from '../../../../tests/mocks/auth.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'
import * as realClaudeAiLimits from 'src/services/claudeAiLimits.js'
import * as realCostTracker from 'src/cost-tracker.js'
import * as realConfig from 'src/utils/config/config.js'
mock.module(
  'src/utils/auth/auth.js',
  authMockWith({
    isClaudeAISubscriber: () => false,
    getOAuthAccount: () => null,
  }),
)

// The three mocks below go through the shared complete-surface pattern
// (overrides listed, every other export delegates to the real module).
// Hand-rolled partial surfaces here used to poison later files in the same
// process: on Linux ordering, local-memory tests died on cost-tracker's
// missing addToTotalLinesChanged. See tests/mocks/sharedModuleMock.ts.
makeSharedModuleMock(
  'src/services/claudeAiLimits.js',
  realClaudeAiLimits,
).setup({
  currentLimits: {
    isUsingOverage: false,
  } as typeof realClaudeAiLimits.currentLimits,
})

makeSharedModuleMock('src/cost-tracker.js', realCostTracker).setup({
  formatTotalCost: () => 'Total cost: $0.0012',
})

makeSharedModuleMock('src/utils/config/config.js', realConfig).setup({
  getCurrentProjectConfig: () =>
    ({}) as ReturnType<typeof realConfig.getCurrentProjectConfig>,
  saveCurrentProjectConfig: () => {},
  getGlobalConfig: () => ({}) as ReturnType<typeof realConfig.getGlobalConfig>,
})

// ── helpers ──────────────────────────────────────────────────────────────────

async function loadUsageCommand() {
  const mod = await import('../index.js')
  return mod.default
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('usage command — metadata', () => {
  test('name is "usage"', async () => {
    const cmd = await loadUsageCommand()
    expect(cmd.name).toBe('usage')
  })

  test('has aliases containing "cost"', async () => {
    const cmd = await loadUsageCommand()
    expect(cmd.aliases?.includes('cost')).toBe(true)
  })

  test('has aliases containing "stats"', async () => {
    const cmd = await loadUsageCommand()
    expect(cmd.aliases?.includes('stats')).toBe(true)
  })

  test('has exactly two aliases', async () => {
    const cmd = await loadUsageCommand()
    expect(cmd.aliases?.length).toBe(2)
  })

  test('aliases are ["cost", "stats"] in that order', async () => {
    const cmd = await loadUsageCommand()
    expect(cmd.aliases).toEqual(['cost', 'stats'])
  })

  test('description mentions cost', async () => {
    const cmd = await loadUsageCommand()
    expect(cmd.description.toLowerCase()).toContain('cost')
  })

  test('description mentions stat', async () => {
    const cmd = await loadUsageCommand()
    expect(cmd.description.toLowerCase()).toContain('stat')
  })

  test('is NOT restricted exclusively to claude-ai subscribers', async () => {
    const cmd = await loadUsageCommand()
    const avail = (cmd as { availability?: string[] }).availability
    const isExclusivelyClaudeAi =
      Array.isArray(avail) && avail.length === 1 && avail[0] === 'claude-ai'
    expect(isExclusivelyClaudeAi).toBe(false)
  })

  test('description mentions usage or plan', async () => {
    const cmd = await loadUsageCommand()
    const desc = cmd.description.toLowerCase()
    expect(desc.includes('usage') || desc.includes('plan')).toBe(true)
  })
})

describe('usage command — cost index is no longer standalone', () => {
  test('cost/index default name is "usage" (delegated) OR it has aliases', async () => {
    const mod = await import('../../cost/index.js')
    const cmd = mod.default
    // After the fix: cost/index either exports name='usage' with aliases,
    // or the cost command has aliases set (it's been demoted to alias)
    const isUnifiedOrAliased =
      cmd.name === 'usage' || (cmd.aliases?.includes('cost') ?? false)
    expect(isUnifiedOrAliased).toBe(true)
  })
})

describe('usage command — stats index is no longer standalone', () => {
  test('stats/index default name is "usage" (delegated) OR it has aliases', async () => {
    const mod = await import('../../stats/index.js')
    const cmd = mod.default
    const isUnifiedOrAliased =
      cmd.name === 'usage' || (cmd.aliases?.includes('stats') ?? false)
    expect(isUnifiedOrAliased).toBe(true)
  })
})
