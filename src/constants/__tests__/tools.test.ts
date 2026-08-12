import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { setupGrowthbookMock } from '../../../tests/mocks/growthbook.js'
import { logMock } from '../../../tests/mocks/log'
import { debugMock } from '../../../tests/mocks/debug'
import { mock } from 'bun:test'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)
// Mock growthbook to cut analytics dependency
// growthbook goes through the shared complete-surface mock (missing exports
// delegate to the real module) — see tests/mocks/growthbook.ts.
const growthbookMock = setupGrowthbookMock({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE: () => false,
})

const { CORE_TOOLS } = await import('../tools.js')
const { isDeferredTool } = await import(
  '@open-claude-code/builtin-tools/tools/SearchExtraToolsTool/prompt.js'
)
const { setGoalPresent } = await import('../../services/goal/goalPresence.js')
const {
  isDeferredToolExecutionPathAvailable,
  isSearchExtraToolsToolAvailable,
} = await import('../../utils/tools/searchExtraTools.js')

type MockTool = {
  name: string
  alwaysLoad?: boolean
  isMcp?: boolean
  shouldDefer?: boolean
}

function makeTool(overrides: Partial<MockTool> = {}): MockTool {
  return {
    name: 'TestTool',
    isMcp: false,
    shouldDefer: undefined,
    alwaysLoad: undefined,
    ...overrides,
  }
}

describe('CORE_TOOLS', () => {
  test('contains expected number of tools', () => {
    // 2 SHELL_TOOL_NAMES ('Bash', 'PowerShell') + 26 independent tool names
    expect(CORE_TOOLS.size).toBeGreaterThanOrEqual(28)
  })

  test('contains key core tool names', () => {
    const expected = [
      'Bash',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'Agent',
      'AskUserQuestion',
      'SearchExtraTools',
      'ExecuteExtraTool',
      'WebSearch',
      'WebFetch',
      'LSP',
      'Skill',
      'TaskCreate',
      'TaskGet',
      'TaskUpdate',
      'TaskList',
      'TaskOutput',
      'TaskStop',
      'TodoWrite',
      'EnterPlanMode',
      'ExitPlanMode',
      'VerifyPlanExecution',
      'NotebookEdit',
      'StructuredOutput',
    ]
    for (const name of expected) {
      expect(CORE_TOOLS.has(name), `CORE_TOOLS should contain ${name}`).toBe(
        true,
      )
    }
  })

  test('is a ReadonlySet', () => {
    // ReadonlySet is not directly distinguishable at runtime from Set,
    // but we verify the cast was applied by checking it's a Set
    expect(CORE_TOOLS).toBeInstanceOf(Set)
    // The `as ReadonlySet<string>` ensures type-level immutability
  })
})

describe('deferred tool execution path availability', () => {
  test('requires both SearchExtraTools and ExecuteExtraTool', () => {
    const tools = [{ name: 'SearchExtraTools' }, { name: 'ExecuteExtraTool' }]

    expect(isSearchExtraToolsToolAvailable(tools)).toBe(true)
    expect(isDeferredToolExecutionPathAvailable(tools)).toBe(true)
  })

  test('is unavailable when ExecuteExtraTool is missing', () => {
    const tools = [{ name: 'SearchExtraTools' }]

    expect(isSearchExtraToolsToolAvailable(tools)).toBe(true)
    expect(isDeferredToolExecutionPathAvailable(tools)).toBe(false)
  })

  test('is unavailable when SearchExtraTools is missing', () => {
    const tools = [{ name: 'ExecuteExtraTool' }]

    expect(isSearchExtraToolsToolAvailable(tools)).toBe(false)
    expect(isDeferredToolExecutionPathAvailable(tools)).toBe(false)
  })
})

describe('isDeferredTool', () => {
  test('returns false for core tools', () => {
    const coreNames = ['Read', 'Edit', 'Bash', 'Glob', 'Grep', 'Agent']
    for (const name of coreNames) {
      const tool = makeTool({ name })
      expect(
        isDeferredTool(tool as never),
        `${name} should not be deferred`,
      ).toBe(false)
    }
  })

  test('returns false for tools with alwaysLoad: true even if not in CORE_TOOLS', () => {
    const tool = makeTool({ name: 'CustomTool', alwaysLoad: true })
    expect(isDeferredTool(tool as never)).toBe(false)
  })

  test('returns true for non-core built-in tools', () => {
    const tool = makeTool({ name: 'ConfigTool' })
    expect(isDeferredTool(tool as never)).toBe(true)
  })

  test('returns true for agent/team tools (TeamCreate, TeamDelete, SendMessage)', () => {
    for (const name of ['TeamCreate', 'TeamDelete', 'SendMessage']) {
      const tool = makeTool({ name })
      expect(isDeferredTool(tool as never), `${name} should be deferred`).toBe(
        true,
      )
    }
  })

  test('returns true for MCP tools', () => {
    const tool = makeTool({ name: 'mcp__server__action', isMcp: true })
    expect(isDeferredTool(tool as never)).toBe(true)
  })

  test('returns false for MCP tools with alwaysLoad: true', () => {
    const tool = makeTool({
      name: 'mcp__server__action',
      isMcp: true,
      alwaysLoad: true,
    })
    expect(isDeferredTool(tool as never)).toBe(false)
  })

  test('alwaysLoad takes precedence over CORE_TOOLS membership', () => {
    // A tool in CORE_TOOLS with alwaysLoad: false should still not be deferred
    const tool = makeTool({ name: 'Read', alwaysLoad: true })
    expect(isDeferredTool(tool as never)).toBe(false)
  })

  test('GoalTool is deferred with no goal, loaded once one exists', () => {
    const tool = makeTool({ name: 'GoalTool' })
    // The presence flag is process-global (bun's module registry is shared
    // across test files), so pin both ends explicitly rather than assuming
    // whatever a previously-run file left behind.
    setGoalPresent(false)
    expect(isDeferredTool(tool as never)).toBe(true)

    // Every <goal-steering> turn tells the model to "use the GoalTool to mark
    // it complete" — behind a SearchExtraTools round-trip that instruction
    // names a tool the model cannot see, so the goal never reaches a terminal
    // state and the loop runs to the turn cap instead of finishing.
    setGoalPresent(true)
    try {
      expect(isDeferredTool(tool as never)).toBe(false)
    } finally {
      setGoalPresent(false)
    }
  })
})

// Overrides are installed at load (the module under test is imported below and
// needs them active), so scope them by resetting at the end instead of moving
// them into beforeAll. Without this they stay installed for every later file
// in the shard — mock.module is process-global.
afterAll(() => {
  growthbookMock.reset()
})
