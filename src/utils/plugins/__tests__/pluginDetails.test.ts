import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LoadedPlugin } from '../../../types/plugin.js'
import { computePluginDetails } from '../pluginDetails.js'

/**
 * These exercise the real loaders against a real plugin tree on disk — the
 * whole point of `plugin details` is that the numbers come from the same code
 * path the session uses, so mocking the loaders would test nothing.
 */

let root: string
let plugin: LoadedPlugin

const SKILL_BODY = 'A'.repeat(500)
const COMMAND_BODY = 'B'.repeat(300)
const AGENT_BODY = 'C'.repeat(200)

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'occ-plugin-details-'))

  mkdirSync(join(root, 'skills', 'greeter'), { recursive: true })
  writeFileSync(
    join(root, 'skills', 'greeter', 'SKILL.md'),
    `---\nname: greeter\ndescription: Greets people warmly\n---\n\n${SKILL_BODY}\n`,
  )

  mkdirSync(join(root, 'commands'), { recursive: true })
  writeFileSync(
    join(root, 'commands', 'described.md'),
    `---\ndescription: Does a described thing\n---\n\n${COMMAND_BODY}\n`,
  )
  // No description and no when_to_use: never reaches the always-on listing.
  writeFileSync(join(root, 'commands', 'bare.md'), `${COMMAND_BODY}\n`)

  mkdirSync(join(root, 'agents'), { recursive: true })
  writeFileSync(
    join(root, 'agents', 'auditor.md'),
    `---\nname: auditor\ndescription: Audits things\ntools: Read, Grep\n---\n\n${AGENT_BODY}\n`,
  )

  plugin = {
    name: 'demo',
    manifest: { name: 'demo', version: '1.2.3' },
    path: root,
    source: 'demo@testmarket',
    repository: 'demo@testmarket',
    enabled: true,
    commandsPath: join(root, 'commands'),
    agentsPath: join(root, 'agents'),
    skillsPath: join(root, 'skills'),
    hooksConfig: { PreToolUse: [], PostToolUse: [] },
  }
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('computePluginDetails', () => {
  test('inventories every component kind the plugin declares', async () => {
    const details = await computePluginDetails(plugin)

    expect(details.pluginId).toBe('demo@testmarket')
    expect(details.version).toBe('1.2.3')
    expect(details.skills.map(s => s.name)).toEqual(['demo:greeter'])
    expect(details.commands.map(c => c.name).sort()).toEqual([
      'demo:bare',
      'demo:described',
    ])
    expect(details.agents.map(a => a.name)).toEqual(['demo:auditor'])
    expect(details.hooks.sort()).toEqual(['PostToolUse', 'PreToolUse'])
  })

  test('always_on is the real listing line, not an estimate', async () => {
    const details = await computePluginDetails(plugin)

    const skill = details.skills[0]!
    expect(skill.listed).toBe(true)
    expect(skill.alwaysOnLine).toBe('- demo:greeter: Greets people warmly')
    expect(skill.alwaysOnChars).toBe(skill.alwaysOnLine.length)

    const agent = details.agents[0]!
    expect(agent.alwaysOnLine).toBe(
      '- demo:auditor: Audits things (Tools: Read, Grep)',
    )
  })

  test('on_invoke is the component body, and dwarfs always_on', async () => {
    const details = await computePluginDetails(plugin)

    const skill = details.skills[0]!
    expect(skill.onInvokeChars).toBeGreaterThanOrEqual(SKILL_BODY.length)
    expect(skill.onInvokeChars).toBeGreaterThan(skill.alwaysOnChars * 10)
    expect(details.cost.onInvokeChars).toBeGreaterThan(
      details.cost.alwaysOnChars,
    )
  })

  test('a command with no description costs nothing per turn', async () => {
    const details = await computePluginDetails(plugin)

    const bare = details.commands.find(c => c.name === 'demo:bare')!
    expect(bare.listed).toBe(false)
    expect(bare.alwaysOnChars).toBe(0)
    // Still loadable by the user typing /demo:bare, so the body still counts.
    expect(bare.onInvokeChars).toBeGreaterThan(0)

    const described = details.commands.find(c => c.name === 'demo:described')!
    expect(described.listed).toBe(true)
    expect(described.alwaysOnChars).toBeGreaterThan(0)
  })

  test('always_on total is the listing lines plus their joining newlines', async () => {
    const details = await computePluginDetails(plugin)

    const listed = [
      ...details.skills,
      ...details.commands,
      ...details.agents,
    ].filter(c => c.listed)
    const expected =
      listed.reduce((sum, c) => sum + c.alwaysOnChars, 0) + (listed.length - 1)
    expect(details.cost.alwaysOnChars).toBe(expected)
  })

  test('reports the budget share against the skill listing budget', async () => {
    const details = await computePluginDetails(plugin, {
      contextWindowTokens: 200_000,
    })

    // 200k tokens x 4 chars x the default 1% fraction.
    expect(details.cost.budgetChars).toBe(8000)
    expect(details.cost.contextWindowTokens).toBe(200_000)
    expect(details.cost.shareOfBudget).toBeCloseTo(
      details.cost.alwaysOnChars / 8000,
      10,
    )
  })

  test('falls back to the character rate when no tokenizer is supplied', async () => {
    const details = await computePluginDetails(plugin)

    expect(details.cost.tokenSource).toBe('chars')
    expect(details.cost.alwaysOnTokens).toBe(
      Math.ceil(details.cost.alwaysOnChars / 4),
    )
  })

  test('uses the injected tokenizer for always_on when it answers', async () => {
    const seen: string[] = []
    const details = await computePluginDetails(plugin, {
      countTokens: async text => {
        seen.push(text)
        return 42
      },
    })

    expect(details.cost.tokenSource).toBe('api')
    expect(details.cost.alwaysOnTokens).toBe(42)
    // The tokenizer must see the exact listing text, not a reconstruction.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('- demo:greeter: Greets people warmly')
    expect(seen[0]).not.toContain('demo:bare')
  })

  test('degrades to the character rate when the tokenizer declines', async () => {
    const details = await computePluginDetails(plugin, {
      countTokens: async () => null,
    })

    expect(details.cost.tokenSource).toBe('chars')
    expect(details.cost.alwaysOnTokens).toBe(
      Math.ceil(details.cost.alwaysOnChars / 4),
    )
  })

  test('honours the settings-backed per-description cap', async () => {
    const details = await computePluginDetails(plugin, {
      budgetOptions: { maxDescChars: 5 },
    })

    // "Greets people warmly" truncated to 4 chars + the ellipsis.
    expect(details.skills[0]!.alwaysOnLine).toBe('- demo:greeter: Gree…')
  })

  test('prices a disabled plugin without enabling it', async () => {
    const details = await computePluginDetails({ ...plugin, enabled: false })

    expect(details.enabled).toBe(false)
    expect(details.skills).toHaveLength(1)
    expect(details.cost.alwaysOnChars).toBeGreaterThan(0)
  })

  test('a plugin with no components costs nothing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'occ-plugin-empty-'))
    try {
      const details = await computePluginDetails({
        name: 'empty',
        manifest: { name: 'empty' },
        path: empty,
        source: 'empty@testmarket',
        repository: 'empty@testmarket',
      })
      expect(details.cost.alwaysOnChars).toBe(0)
      expect(details.cost.onInvokeChars).toBe(0)
      expect(details.cost.alwaysOnTokens).toBe(0)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
