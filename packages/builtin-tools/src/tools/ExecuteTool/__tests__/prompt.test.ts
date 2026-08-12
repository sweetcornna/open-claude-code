/**
 * ExecuteExtraTool's description is the one place in the codebase where a
 * target tool's field names are written out by hand, and nothing used to check
 * them against the real schema. They drifted: the worked example taught
 * `{"schedule": ...}` while CronCreateTool's strictObject wants `cron` and
 * rejects unknown keys — so a model that followed the example verbatim failed
 * validation every time, on the exact mistake the guard in ExecuteTool.ts
 * calls out by name.
 *
 * This test closes that class of drift rather than the one instance: it pulls
 * the params object straight out of the rendered prompt and runs it through
 * the tool's own schema.
 */
import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { getPrompt } = await import('../prompt.js')
const { CronCreateTool } = await import(
  '../../ScheduleCronTool/CronCreateTool.js'
)

/** Pull `ExecuteExtraTool({...})` calls out of the rendered description. */
function exampleCalls(
  prompt: string,
): { tool_name: string; params: Record<string, unknown> }[] {
  const calls: { tool_name: string; params: Record<string, unknown> }[] = []
  for (const match of prompt.matchAll(/ExecuteExtraTool\((\{.*\})\)/g)) {
    calls.push(JSON.parse(match[1]!))
  }
  return calls
}

describe('ExecuteExtraTool worked examples', () => {
  const calls = exampleCalls(getPrompt())

  test('the description still contains a worked example', () => {
    expect(calls.length).toBeGreaterThan(0)
  })

  test('every example is well-formed', () => {
    for (const call of calls) {
      expect(typeof call.tool_name).toBe('string')
      expect(typeof call.params).toBe('object')
    }
  })

  test('the CronCreate example validates against CronCreate itself', () => {
    const call = calls.find(c => c.tool_name === 'CronCreate')
    expect(call).toBeDefined()

    const parsed = CronCreateTool.inputSchema.safeParse(call!.params)
    expect(parsed.success).toBe(true)
  })

  test('examples only name tools that exist here', () => {
    // MCP tool names are illustrative (no server is connected in a test), but
    // a built-in named in an example has to be real — the model is being told
    // it can call it.
    const builtinExamples = calls.filter(c => !c.tool_name.startsWith('mcp__'))
    expect(builtinExamples.map(c => c.tool_name)).toEqual(['CronCreate'])
  })
})
