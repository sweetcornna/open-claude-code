/**
 * The deferred-tool announcement channel.
 *
 * This path had no unit coverage at all while it was dead code behind an
 * always-false gate. It is now the live default, and three things about it are
 * easy to break silently:
 *
 *   1. The gate is read from two modules that cannot import each other
 *      (searchExtraTools.ts imports SearchExtraToolsTool/prompt.ts). They used
 *      to hold hand-copied duplicates; if they disagree, the tool description
 *      tells the model to look for tool names in a message that isn't there.
 *   2. The delta must announce each tool exactly once. Re-announcing every turn
 *      is the bug the whole mechanism exists to fix; announcing zero times
 *      leaves the model unaware of every deferred tool.
 *   3. Being *announced* is not the same as having *seen the schema*. Conflating
 *      them disables ExecuteExtraTool's "search first" guard, and the model then
 *      guesses field names against strictObject schemas.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const {
  DEFERRED_DELTA_LIST_CAP,
  extractDiscoveredToolNames,
  getDeferredToolsDelta,
  isDeferredToolsDeltaEnabled,
  shouldAppendEphemeralDeferredToolList,
} = await import('../searchExtraTools.js')
const { getPrompt } = await import(
  '@open-claude-code/builtin-tools/tools/SearchExtraToolsTool/prompt.js'
)
// Read the name from the module rather than restating it: a renamed escape
// hatch that still passes its own tests is the worst outcome here.
const { DEFERRED_TOOLS_DELTA_ENV_VAR: ENV_VAR } = await import(
  '@open-claude-code/builtin-tools/tools/SearchExtraToolsTool/deferredToolsDelta.js'
)
const original = process.env[ENV_VAR]

afterEach(() => {
  if (original === undefined) delete process.env[ENV_VAR]
  else process.env[ENV_VAR] = original
})

function setGate(value: string | undefined): void {
  if (value === undefined) delete process.env[ENV_VAR]
  else process.env[ENV_VAR] = value
}

function tool(name: string): { name: string } {
  return { name }
}

function toolPool(names: string[]): never {
  return names.map(tool) as never
}

function deltaAttachment(
  addedNames: string[],
  removedNames: string[] = [],
): never {
  return {
    type: 'attachment',
    attachment: {
      type: 'deferred_tools_delta',
      addedNames,
      addedLines: addedNames,
      removedNames,
    },
  } as never
}

describe('the deferred_tools_delta gate', () => {
  test('is on by default', () => {
    setGate(undefined)
    expect(isDeferredToolsDeltaEnabled()).toBe(true)
  })

  test('empty string is not an opt-out', () => {
    setGate('')
    expect(isDeferredToolsDeltaEnabled()).toBe(true)
  })

  test.each([
    '0',
    'false',
    'no',
    'off',
    'FALSE',
    ' off ',
  ])('%p turns it off', value => {
    setGate(value)
    expect(isDeferredToolsDeltaEnabled()).toBe(false)
  })

  test.each(['1', 'true', 'yes', 'on'])('%p leaves it on', value => {
    setGate(value)
    expect(isDeferredToolsDeltaEnabled()).toBe(true)
  })
})

describe('the ephemeral <available-deferred-tools> fallback', () => {
  test('is skipped while the delta is on — this is the whole point', () => {
    setGate(undefined)
    expect(shouldAppendEphemeralDeferredToolList(true)).toBe(false)
  })

  test('comes back when the delta is switched off', () => {
    setGate('0')
    expect(shouldAppendEphemeralDeferredToolList(true)).toBe(true)
  })

  test('never fires when tool search itself is off', () => {
    setGate('0')
    expect(shouldAppendEphemeralDeferredToolList(false)).toBe(false)
  })
})

describe("SearchExtraTools' description agrees with the gate", () => {
  // Guards the duplicated-predicate drift: pointing the model at the wrong
  // carrier is invisible in every other test, and produces a model that
  // searches for a message which is never sent.
  test('points at system-reminder messages when the delta is on', () => {
    setGate('1')
    expect(getPrompt()).toContain(
      'Deferred tools appear by name in <system-reminder> messages.',
    )
  })

  test('points at <available-deferred-tools> when the delta is off', () => {
    setGate('0')
    expect(getPrompt()).toContain(
      'Deferred tools appear by name in <available-deferred-tools> messages.',
    )
  })
})

describe('getDeferredToolsDelta', () => {
  test('announces the whole pool on the first turn', () => {
    const delta = getDeferredToolsDelta(
      toolPool(['CronCreate', 'mcp__slack__send', 'Read']),
      [],
    )
    expect(delta).not.toBeNull()
    // 'Read' is a core tool, so it is not deferred and must not be announced.
    expect(delta!.addedNames).toEqual(['CronCreate', 'mcp__slack__send'])
    expect(delta!.removedNames).toEqual([])
  })

  test('says nothing on the next turn — no per-turn re-announcement', () => {
    const tools = toolPool(['CronCreate', 'mcp__slack__send'])
    const first = getDeferredToolsDelta(tools, [])
    const second = getDeferredToolsDelta(tools, [
      deltaAttachment(first!.addedNames),
    ])
    expect(second).toBeNull()
  })

  test('announces only what is new when a server connects mid-session', () => {
    const delta = getDeferredToolsDelta(
      toolPool(['CronCreate', 'mcp__slack__send']),
      [deltaAttachment(['CronCreate'])],
    )
    expect(delta!.addedNames).toEqual(['mcp__slack__send'])
  })

  test('reports a tool that left the pool entirely as removed', () => {
    const delta = getDeferredToolsDelta(toolPool(['CronCreate']), [
      deltaAttachment(['CronCreate', 'mcp__slack__send']),
    ])
    expect(delta!.removedNames).toEqual(['mcp__slack__send'])
  })

  test('a tool that stopped being deferred is not "no longer available"', () => {
    // It is still callable, just directly — telling the model it vanished
    // would be a lie that costs a capability.
    const delta = getDeferredToolsDelta(toolPool(['Read']), [
      deltaAttachment(['Read']),
    ])
    expect(delta).toBeNull()
  })

  test('caps the rendered list but keeps the full bookkeeping set', () => {
    const names = Array.from(
      { length: DEFERRED_DELTA_LIST_CAP + 12 },
      (_, i) => `mcp__server__tool_${String(i).padStart(3, '0')}`,
    )
    const delta = getDeferredToolsDelta(toolPool(names), [])
    expect(delta!.addedLines).toHaveLength(DEFERRED_DELTA_LIST_CAP)
    expect(delta!.addedNames).toHaveLength(names.length)

    // The cap must not cause a re-announcement loop: everything in addedNames
    // counts as announced, listed or not.
    expect(
      getDeferredToolsDelta(toolPool(names), [
        deltaAttachment(delta!.addedNames),
      ]),
    ).toBeNull()
  })
})

describe('announcement is not discovery', () => {
  test('a delta attachment does not mark its tools as discovered', () => {
    const discovered = extractDiscoveredToolNames([
      deltaAttachment(['CronCreate', 'mcp__slack__send']),
    ])
    expect(discovered.size).toBe(0)
  })

  test('an actual SearchExtraTools result does', () => {
    const discovered = extractDiscoveredToolNames([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'x',
              content:
                'Found 1 deferred tool(s): CronCreate.\nUse ExecuteExtraTool …',
            },
          ],
        },
      } as never,
    ])
    expect([...discovered]).toEqual(['CronCreate'])
  })
})
