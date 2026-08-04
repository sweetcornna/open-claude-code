/**
 * Regression: the subagent spawn-depth guard must key on nesting level, not on
 * query-chain depth.
 *
 * The guard originally read `toolUseContext.queryTracking.depth`, which query()
 * increments once per loop iteration (i.e. per tool round-trip). Any main-loop
 * turn that used 3+ tools therefore hit `Subagent nesting depth limit reached`
 * on the very first Agent/Workflow spawn, from the top level.
 */
import { mock, describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { createFileStateCacheWithSizeLimit } from '../../fileStateCache.js'
import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolUseContext } from '../../../Tool.js'

mock.module('src/utils/telemetry/log.ts', logMock)

const { createSubagentContext } = await import('../forkedAgent.js')
const { checkSpawnBudgets, resetSpawnBudgetsForTests } = await import(
  '@open-claude-code/builtin-tools/tools/AgentTool/spawnLimits.js'
)

function makeMainThreadContext(queryChainDepth: number): ToolUseContext {
  return {
    ...getEmptyToolPermissionContext(),
    messages: [],
    abortController: new AbortController(),
    readFileState: createFileStateCacheWithSizeLimit(1),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
    setAppState: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    queryTracking: { chainId: 'chain', depth: queryChainDepth },
  } as never
}

describe('subagent nesting depth', () => {
  beforeEach(() => {
    resetSpawnBudgetsForTests()
    delete process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH
  })
  afterEach(() => {
    resetSpawnBudgetsForTests()
  })

  test('main thread can spawn no matter how many tool round-trips it has made', () => {
    // 42 tool round-trips in this turn — used to throw at >= 3.
    const main = makeMainThreadContext(42)
    expect(main.agentDepth).toBeUndefined()
    expect(() => checkSpawnBudgets(main.agentDepth)).not.toThrow()
  })

  test('agentDepth increments once per nesting level, ignoring query depth', () => {
    const main = makeMainThreadContext(7)
    const level1 = createSubagentContext(main)
    const level2 = createSubagentContext(level1)
    const level3 = createSubagentContext(level2)

    expect(level1.agentDepth).toBe(1)
    expect(level2.agentDepth).toBe(2)
    expect(level3.agentDepth).toBe(3)

    // queryTracking.depth keeps climbing from the parent's chain — proof the
    // two counters are independent and must not be conflated.
    expect(level1.queryTracking?.depth).toBe(8)
  })

  test('the limit still bites at the configured nesting level', () => {
    const main = makeMainThreadContext(0)
    const level3 = createSubagentContext(
      createSubagentContext(createSubagentContext(main)),
    )
    expect(() => checkSpawnBudgets(level3.agentDepth)).toThrow(
      'nesting depth limit',
    )
  })
})
