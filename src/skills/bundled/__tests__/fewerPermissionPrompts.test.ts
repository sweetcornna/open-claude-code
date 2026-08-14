import { afterEach, describe, expect, test } from 'bun:test'

import { PROJECT_DIR_NAME } from '../../../config/paths.js'
import type { Command, PromptCommand } from '../../../types/command.js'
import { clearBundledSkills, getBundledSkills } from '../../bundledSkills.js'
import { registerFewerPermissionPromptsSkill } from '../fewerPermissionPrompts.js'

// Command is a union; getPromptForCommand only exists on the prompt variant.
function asPrompt(c: Command): PromptCommand {
  return c as unknown as PromptCommand
}

afterEach(() => {
  clearBundledSkills()
})

function register(): Command {
  clearBundledSkills()
  registerFewerPermissionPromptsSkill()
  return getBundledSkills().find(s => s.name === 'fewer-permission-prompts')!
}

async function promptText(args = ''): Promise<string> {
  const blocks = await asPrompt(register()).getPromptForCommand(
    args,
    {} as never,
  )
  return (blocks[0] as { text: string }).text
}

describe('registerFewerPermissionPromptsSkill', () => {
  test('registers a user-invocable bundled prompt command', () => {
    const skill = register()
    expect(skill.type).toBe('prompt')
    expect(skill.userInvocable).toBe(true)
    expect(asPrompt(skill).source).toBe('bundled')
  })

  test('targets the occ project settings file, never a hardcoded .claude path', async () => {
    const text = await promptText()
    expect(text).toContain(`${PROJECT_DIR_NAME}/settings.json`)
    // The official skill hardcodes `.claude/settings.json`. occ's project asset
    // directory is PROJECT_DIR_NAME, and pointing the model at the official
    // CLI's directory would write allowlist entries occ never reads.
    expect(text).not.toContain('.claude/settings.json')
  })

  test('names occ read-only validation sources instead of inlining the list', async () => {
    const text = await promptText()
    expect(text).toContain(
      'packages/builtin-tools/src/tools/BashTool/readOnlyValidation.ts',
    )
    expect(text).toContain('src/utils/shell/readOnlyCommandValidation.ts')
  })

  test('keeps the arbitrary-code-execution prohibition', async () => {
    const text = await promptText()
    expect(text).toContain('arbitrary code execution')
    expect(text).toContain('bun run *')
  })

  test('states the prefix-match space rule', async () => {
    expect(await promptText()).toContain('space before')
  })

  test('forbids writing deny/ask rules', async () => {
    const text = await promptText()
    expect(text).toContain('permissions.deny')
    expect(text).toContain('permissions.ask')
  })

  test('appends user arguments as a separate section', async () => {
    const text = await promptText('only git commands')
    expect(text).toContain('## Additional instructions from the user')
    expect(text).toContain('only git commands')
  })
})
