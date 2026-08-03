import { afterEach, describe, expect, test } from 'bun:test'

import type { PromptCommand } from '../../../types/command.js'
import { clearBundledSkills, getBundledSkills } from '../../bundledSkills.js'
import { registerUpdateConfigSkill } from '../updateConfig.js'

// Command is a union; getPromptForCommand only exists on the prompt variant.
function asPrompt(c: { type: string }): PromptCommand {
  return c as unknown as PromptCommand
}

// bundledSkills is a process-global registry — clear after each test so
// `update-config` never leaks into other suites (per ultracode.test.ts).
afterEach(() => {
  clearBundledSkills()
})

describe('registerUpdateConfigSkill', () => {
  test('registers a user-invocable prompt command named update-config', () => {
    clearBundledSkills()
    registerUpdateConfigSkill()

    const skill = getBundledSkills().find(s => s.name === 'update-config')
    expect(skill).toBeDefined()
    expect(skill!.userInvocable).toBe(true)
  })

  // 回归：SettingsSchema 的 union 里含 z.undefined()，zod v4 toJSONSchema 默认
  // unrepresentable:'throw' 会抛 "Undefined cannot be represented in JSON Schema"，
  // 让 skill 在 Initializing 阶段直接崩掉。
  test('getPromptForCommand does not throw on schema generation and embeds the schema', async () => {
    clearBundledSkills()
    registerUpdateConfigSkill()

    const skill = getBundledSkills().find(s => s.name === 'update-config')!
    const blocks = await asPrompt(skill).getPromptForCommand('', {} as never)
    expect(blocks).toHaveLength(1)

    const text = (blocks[0] as { type: 'text'; text: string }).text
    expect(text).toContain('Full Settings JSON Schema')
    expect(text).toContain('"properties"')
  })

  test('[hooks-only] mode skips schema generation and returns hooks docs', async () => {
    clearBundledSkills()
    registerUpdateConfigSkill()

    const skill = getBundledSkills().find(s => s.name === 'update-config')!
    const blocks = await asPrompt(skill).getPromptForCommand(
      '[hooks-only] add a formatter hook',
      {} as never,
    )
    const text = (blocks[0] as { type: 'text'; text: string }).text
    expect(text).toContain('Hooks Configuration')
    expect(text).not.toContain('Full Settings JSON Schema')
    expect(text).toContain('add a formatter hook')
  })
})
