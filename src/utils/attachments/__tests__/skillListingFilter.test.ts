import { afterEach, describe, expect, test } from 'bun:test'

import type { Command } from '../../../types/command.js'
import type { ToolUseContext } from '../../../Tool.js'
import {
  clearBundledSkills,
  getBundledSkills,
} from '../../../skills/bundledSkills.js'
import { registerUltracodeSkill } from '../../../skills/bundled/ultracode.js'
import { filterByListPredicate } from '../skills.js'

// bundledSkills is a process-global registry; leaving `ultracode` in it would
// leak into any other suite that enumerates registered skills.
afterEach(() => {
  clearBundledSkills()
})

function ctx(ultracodeMode: boolean | undefined): ToolUseContext {
  return {
    getAppState: () => ({ ultracodeMode }),
  } as unknown as ToolUseContext
}

function plainSkill(name: string): Command {
  return {
    type: 'prompt',
    name,
    description: `${name} description`,
    source: 'bundled',
    loadedFrom: 'bundled',
    progressMessage: 'running',
    contentLength: 0,
    getPromptForCommand: async () => [],
  } as unknown as Command
}

function ultracodeCommand(): Command {
  clearBundledSkills()
  registerUltracodeSkill()
  return getBundledSkills().find(s => s.name === 'ultracode')!
}

describe('filterByListPredicate', () => {
  test('keeps every command that declares no listWhen', () => {
    const commands = [plainSkill('a'), plainSkill('b')]
    expect(
      filterByListPredicate(commands, ctx(false)).map(c => c.name),
    ).toEqual(['a', 'b'])
  })

  test('drops the ultracode skill from the listing when the mode is off', () => {
    // The listing attachment is injected into every session. ultracode's
    // whenToUse actively pitches multi-agent fan-out, so leaving it in an
    // unopted session is unconditional encouragement to spend that scale.
    const commands = [plainSkill('a'), ultracodeCommand(), plainSkill('b')]

    expect(
      filterByListPredicate(commands, ctx(false)).map(c => c.name),
    ).toEqual(['a', 'b'])
    expect(
      filterByListPredicate(commands, ctx(undefined)).map(c => c.name),
    ).toEqual(['a', 'b'])
  })

  test('lists the ultracode skill once the mode is on', () => {
    const commands = [plainSkill('a'), ultracodeCommand()]
    expect(filterByListPredicate(commands, ctx(true)).map(c => c.name)).toEqual(
      ['a', 'ultracode'],
    )
  })

  test('re-evaluates per call, so a mid-session toggle takes effect', () => {
    // Ultracode is toggled from the /effort panel at any point in a session.
    // A gate resolved once at registration would leave the listing describing
    // whatever the state was at startup.
    const commands = [ultracodeCommand()]
    let mode = false
    const liveCtx = {
      getAppState: () => ({ ultracodeMode: mode }),
    } as unknown as ToolUseContext

    expect(filterByListPredicate(commands, liveCtx)).toHaveLength(0)
    mode = true
    expect(filterByListPredicate(commands, liveCtx)).toHaveLength(1)
    mode = false
    expect(filterByListPredicate(commands, liveCtx)).toHaveLength(0)
  })
})
