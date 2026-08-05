import { afterEach, describe, expect, test } from 'bun:test'

import type { PromptCommand } from '../../../types/command.js'
import { clearBundledSkills, getBundledSkills } from '../../bundledSkills.js'
import {
  DEFAULT_MAX_CONCURRENCY,
  MAX_CONCURRENCY_CAP,
} from '@open-claude-code/workflow-engine'
import { registerUltracodeSkill } from '../ultracode.js'

// Command is a union; source/getPromptForCommand only exist on the prompt
// variant. Narrow via type assertion once we've confirmed type === 'prompt'.
function asPrompt(c: { type: string }): PromptCommand {
  return c as unknown as PromptCommand
}

// bundledSkills is a process-global registry (per CLAUDE.md mock/state rules,
// module-level singletons leak across test files in one bun test process).
// Clear after each test so `ultracode` never leaks into other suites that
// enumerate registered skills (e.g. skill-search prefetch discovery).
afterEach(() => {
  clearBundledSkills()
})

describe('registerUltracodeSkill', () => {
  test('registers a user-invocable prompt command named ultracode', () => {
    clearBundledSkills()
    registerUltracodeSkill()

    const skills = getBundledSkills()
    const ultracode = skills.find(s => s.name === 'ultracode')
    expect(ultracode).toBeDefined()
    expect(ultracode!.type).toBe('prompt')
    expect(ultracode!.userInvocable).toBe(true)
    expect(ultracode!.whenToUse).toBeTruthy()
    expect(ultracode!.description).toContain('workflow')
    const promptCmd = asPrompt(ultracode!)
    expect(promptCmd.source).toBe('bundled')
  })

  test('getPromptForCommand injects the orchestration playbook with key sections', async () => {
    clearBundledSkills()
    registerUltracodeSkill()

    const ultracode = getBundledSkills().find(s => s.name === 'ultracode')!
    const blocks = await asPrompt(ultracode).getPromptForCommand(
      '',
      {} as never,
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('text')

    const text = (blocks[0] as { type: 'text'; text: string }).text
    // Title + opt-in rule + harness-injection note
    expect(text).toContain('Workflow Orchestration Playbook')
    expect(text).toContain('explicitly opted into multi-agent orchestration')
    expect(text).toContain('harness')
    // Orchestration primitives
    expect(text).toContain('Script body hooks')
    expect(text).toContain('parallel')
    expect(text).toContain('pipeline')
    // Determinism / script-execution-model constraints (JS not TS; Date.now/Math.random throw)
    expect(text).toContain('plain JavaScript, NOT TypeScript')
    expect(text).toContain('Date.now()')
    // Barrier vs pipeline guidance, quality patterns, resume, hard limits
    expect(text).toContain('DEFAULT TO pipeline()')
    expect(text).toContain('Quality patterns')
    expect(text).toContain('resumeFromRunId')
    expect(text).toContain('4096')
  })

  test('concurrency guidance quotes the engine constant, not a hardcoded number', async () => {
    // The playbook tells the model to interrupt the user via AskUserQuestion for any
    // non-default concurrency. If this text drifts from DEFAULT_MAX_CONCURRENCY, the model
    // asks permission for the value it should have used silently (and recommends a value
    // the engine will not actually apply).
    clearBundledSkills()
    registerUltracodeSkill()
    const ultracode = getBundledSkills().find(s => s.name === 'ultracode')!
    const blocks = await asPrompt(ultracode).getPromptForCommand(
      '',
      {} as never,
    )
    const text = (blocks[0] as { type: 'text'; text: string }).text
    const d = String(DEFAULT_MAX_CONCURRENCY)
    expect(text).toContain(`capped at ${d} by default`)
    expect(text).toContain(`with ${d} marked "(Recommended)"`)
    expect(text).toContain(`${d} is the recommended default`)
    expect(text).toContain(`1–${MAX_CONCURRENCY_CAP}`)
    // the "user already said a number" example must not collide with the default,
    // or it stops illustrating the exception it is there to illustrate
    expect(text).not.toContain(`("use ${d}"`)
  })

  test('appends user-provided args to the prompt when given', async () => {
    clearBundledSkills()
    registerUltracodeSkill()

    const ultracode = getBundledSkills().find(s => s.name === 'ultracode')!
    const blocks = await asPrompt(ultracode).getPromptForCommand(
      '迁移 auth 模块',
      {} as never,
    )
    const text = (blocks[0] as { type: 'text'; text: string }).text
    expect(text.endsWith('迁移 auth 模块\n')).toBe(true)
    expect(text).toContain('User input')
  })

  test('is not gated behind USER_TYPE — registers with no env set', () => {
    // No USER_TYPE env is configured in this test process. If the skill were
    // ant-gated (like stuck.ts), it would not appear here.
    const previousUserType = process.env.USER_TYPE
    delete process.env.USER_TYPE
    clearBundledSkills()
    registerUltracodeSkill()

    const skills = getBundledSkills()
    expect(skills.some(s => s.name === 'ultracode')).toBe(true)

    // Restore so we never mutate the process env for other test files.
    if (previousUserType === undefined) delete process.env.USER_TYPE
    else process.env.USER_TYPE = previousUserType
  })
})
