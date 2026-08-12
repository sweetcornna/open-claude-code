/**
 * Characterization test for the assembled built-in tool inventory.
 *
 * ORDER IS LOAD-BEARING. The tool list order feeds the system-prompt cache key
 * shared across users (see the statsig note above getAllBaseTools in
 * src/tools.ts). Reordering the registry silently invalidates that cache, so
 * this test pins the exact ordered name list rather than a set.
 *
 * The fixture is the plain `bun test` environment: every feature() gate is off
 * (bun:bundle resolves them to false outside a define-injected build),
 * USER_TYPE is unset, and NODE_ENV === 'test'. Everything reachable from there
 * by flipping a single env var at call time is pinned as a separate variant, so
 * the conditional branches inside the registry are covered too.
 *
 * All assertions go through src/tools.ts's public getAllBaseTools() entry, which
 * must keep behaving identically no matter where the registry list itself lives.
 */
import { describe, expect, test } from 'bun:test'
import { getAllBaseTools, getToolsForDefaultPreset } from '../tools.js'

/**
 * The full ordered inventory with every predicate at its default value.
 * Byte-identical output is the contract; update this list only together with a
 * deliberate, reviewed change to the registry order.
 */
const BASE_TOOL_NAMES: readonly string[] = [
  'Agent',
  'TaskOutput',
  'Bash',
  'Glob',
  'Grep',
  'ExitPlanMode',
  'Read',
  'Edit',
  'Write',
  'NotebookEdit',
  'artifact',
  'WebFetch',
  'TodoWrite',
  'WebSearch',
  'TaskStop',
  'AskUserQuestion',
  'Skill',
  'EnterPlanMode',
  'LocalMemoryRecall',
  'VaultHttpFetch',
  'EnterWorktree',
  'ExitWorktree',
  'SendMessage',
  'TeamCreate',
  'TeamDelete',
  'CronCreate',
  'CronDelete',
  'CronList',
  'SendUserMessage',
  'TestingPermission',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'WaitForMcpServers',
  'RefreshMcpTools',
  'SearchExtraTools',
  'ExecuteExtraTool',
]

function toolNames(): string[] {
  return getAllBaseTools().map(tool => tool.name)
}

/**
 * Runs `fn` with the given env vars set, then restores the previous values.
 * The registry reads these predicates on every call, so no module reload or
 * mock is needed — which is exactly why these branches stay cheap to pin.
 */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/** Names present in the variant but not in the default inventory, in order. */
function added(names: string[]): string[] {
  return names.filter(name => !BASE_TOOL_NAMES.includes(name))
}

/** Names shared with the default inventory, in the variant's own order. */
function retained(names: string[]): string[] {
  return names.filter(name => BASE_TOOL_NAMES.includes(name))
}

describe('getAllBaseTools inventory', () => {
  test('returns the pinned ordered tool list for the default environment', () => {
    expect(toolNames()).toEqual([...BASE_TOOL_NAMES])
  })

  test('is stable across calls', () => {
    expect(toolNames()).toEqual(toolNames())
  })

  test('leaves no env residue after a variant run', () => {
    withEnv({ ENABLE_LSP_TOOL: '1' }, toolNames)
    expect(toolNames()).toEqual([...BASE_TOOL_NAMES])
  })
})

describe('getAllBaseTools conditional branches', () => {
  test('ENABLE_LSP_TOOL inserts LSP directly after VaultHttpFetch', () => {
    const names = withEnv({ ENABLE_LSP_TOOL: '1' }, toolNames)
    expect(added(names)).toEqual(['LSP'])
    expect(names.indexOf('LSP')).toBe(names.indexOf('VaultHttpFetch') + 1)
    expect(retained(names)).toEqual([...BASE_TOOL_NAMES])
  })

  test('EMBEDDED_SEARCH_TOOLS drops Glob and Grep and nothing else', () => {
    const names = withEnv({ EMBEDDED_SEARCH_TOOLS: '1' }, toolNames)
    expect(added(names)).toEqual([])
    expect(names).toEqual(
      BASE_TOOL_NAMES.filter(name => name !== 'Glob' && name !== 'Grep'),
    )
  })

  test('CLAUDE_CODE_ENABLE_TASKS inserts the four task tools after VaultHttpFetch', () => {
    const names = withEnv({ CLAUDE_CODE_ENABLE_TASKS: '1' }, toolNames)
    expect(added(names)).toEqual([
      'TaskCreate',
      'TaskGet',
      'TaskUpdate',
      'TaskList',
    ])
    expect(names.indexOf('TaskCreate')).toBe(
      names.indexOf('VaultHttpFetch') + 1,
    )
    expect(retained(names)).toEqual([...BASE_TOOL_NAMES])
  })

  test('combined env flags compose without reordering the shared prefix', () => {
    const names = withEnv(
      { ENABLE_LSP_TOOL: '1', CLAUDE_CODE_ENABLE_TASKS: '1' },
      toolNames,
    )
    expect(added(names)).toEqual([
      'TaskCreate',
      'TaskGet',
      'TaskUpdate',
      'TaskList',
      'LSP',
    ])
    expect(retained(names)).toEqual([...BASE_TOOL_NAMES])
  })
})

describe('getToolsForDefaultPreset', () => {
  test('is an order-preserving subsequence of the base inventory', () => {
    const preset = getToolsForDefaultPreset()
    const base = toolNames()
    expect(preset.length).toBeGreaterThan(0)

    let cursor = 0
    for (const name of preset) {
      const index = base.indexOf(name, cursor)
      expect(index).toBeGreaterThanOrEqual(0)
      cursor = index + 1
    }
  })
})
