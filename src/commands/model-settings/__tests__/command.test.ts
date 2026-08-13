/**
 * `/model-settings` and `/models-setting` used to be two commands whose names
 * differed only in where the `s` sat, and both wrote `settings.modelSettings`.
 * They are one command now, with the old name kept as an alias.
 *
 * Two things have to stay true for that merge to be safe, and neither is
 * visible from the parser tests next door:
 *
 *   1. The alias resolves through the real registry — to the SAME command, not
 *      to a second registration that happens to answer the same name.
 *   2. The scriptable forms still produce their documented output. They are the
 *      half a merge is most likely to lose, because the interactive half is the
 *      one that got a new home.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isValidElement } from 'react'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import type { SettingsJson } from '../../../utils/settings/types.js'
import {
  builtInCommandNames,
  type Command,
  findCommand,
} from '../../../commands.js'
import modelSettings from '../index.js'

// In-memory settings so the persisting forms can be exercised end to end
// without touching the user's real settings.json.
let userSettings: SettingsJson = {}
const settingsMock = setupSettingsMock()

/**
 * A developer running this on a machine configured for a third-party provider
 * would otherwise get the wizard where the suite expects the text panel, so the
 * provider-selecting keys are pinned rather than inherited. ANTHROPIC_API_KEY
 * is set for the opposite reason: building the built-in registry evaluates
 * /login, which throws outright when no credential is present. Nothing here
 * reads the key; it only has to exist.
 */
const ENV_PINS: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: 'sk-ant-test-registry',
  ANTHROPIC_BASE_URL: undefined,
  OPENAI_BASE_URL: undefined,
  OPENCODE_MODEL: undefined,
  CLAUDE_CODE_USE_BEDROCK: undefined,
  CLAUDE_CODE_USE_VERTEX: undefined,
  CLAUDE_CODE_USE_FOUNDRY: undefined,
  CLAUDE_CODE_USE_OPENAI: undefined,
  CLAUDE_CODE_USE_GEMINI: undefined,
  CLAUDE_CODE_USE_GROK: undefined,
  CLAUDE_CODE_EFFORT_LEVEL: undefined,
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: undefined,
}
const savedEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV_PINS)) {
    savedEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  settingsMock.set({
    getInitialSettings: () => ({}),
    getSettingsForSource: source =>
      source === 'userSettings' ? userSettings : {},
    updateSettingsForSource: (_source, patch) => {
      userSettings = { ...userSettings, ...patch }
      return { error: null }
    },
  })
})

afterAll(() => {
  settingsMock.reset()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** Run the command's argument form and capture what it told the user. */
async function run(args: string): Promise<string> {
  const { call } = await import('../model-settings.js')
  let output = ''
  const result = await call(
    message => {
      output = typeof message === 'string' ? message : ''
    },
    // The argument forms never touch AppState; they answer without rendering.
    { setAppState: () => {} } as never,
    args,
  )
  expect(result).toBeUndefined()
  return output
}

describe('the merged command surface', () => {
  test('both names are live in the built-in registry', () => {
    expect(modelSettings.name).toBe('model-settings')
    const names = builtInCommandNames()
    expect(names.has('model-settings')).toBe(true)
    expect(names.has('models-setting')).toBe(true)
  })

  test('the old name resolves to this command, through the real lookup', () => {
    // findCommand is what the REPL uses. Before the merge `models-setting` was
    // a second registration, so it resolved here to nothing at all.
    const commands: Command[] = [modelSettings]
    expect(findCommand('models-setting', commands)).toBe(modelSettings)
    expect(findCommand('model-settings', commands)).toBe(modelSettings)
  })

  test('nothing registers a second models command alongside it', () => {
    // The merge is only a merge if the old command is gone from the registry;
    // an alias plus a surviving `/models-setting` registration would resolve to
    // whichever came first in the list and leave the /help duplication intact.
    const source = readFileSync(
      resolve(import.meta.dir, '..', '..', '..', 'commands.ts'),
      'utf8',
    )
    expect(source).not.toContain('./commands/models/')
    expect(source.match(/model-settings/g)).toHaveLength(1)
  })

  test('one description covers all three axes it now owns', () => {
    // The /help listing showed two rows that read as duplicates. Whatever the
    // wording, the single row left has to mention the models as well as the
    // two knobs the text panel owns.
    expect(modelSettings.description).toMatch(/model/i)
    expect(modelSettings.description).toMatch(/effort/i)
    expect(modelSettings.description).toMatch(/context/i)
  })
})

describe('the scriptable forms survive the merge', () => {
  test('help prints the usage block', async () => {
    for (const form of ['help', '--help', '-h', '?']) {
      const output = await run(form)
      expect(output).toStartWith('Usage:')
      expect(output).toContain('/model-settings show')
      expect(output).toContain('/model-settings opus reset')
    }
  })

  test('show prints one row per slot plus the usage block', async () => {
    const output = await run('show')
    expect(output).toStartWith('Model settings (env still wins over these):')
    for (const slot of ['default', 'haiku', 'sonnet', 'opus', 'fable']) {
      expect(output).toMatch(new RegExp(`^\\s+${slot}\\s`, 'm'))
    }
    expect(output).toContain('Usage:')
  })

  test('current is accepted as a synonym of show', async () => {
    expect(await run('current')).toBe(await run('show'))
  })

  test('setting slot effort preserves and explains the global override', async () => {
    userSettings = { effortLevel: 'low' }
    const output = await run('opus effort max')
    expect(output).toStartWith('opus: effort=max')
    expect(output).toContain('global /effort=low still overrides it')
    expect(output).toContain('/effort auto')
    expect(userSettings.modelSettings?.opus?.effort).toBe('max')
    expect(userSettings.effortLevel).toBe('low')
  })

  test('setting a context window persists it and does not mention effort', async () => {
    userSettings = {}
    const output = await run('haiku context 128k')
    expect(output).toStartWith('haiku: ')
    expect(output).toContain('context=128k')
    expect(output).not.toContain('effortLevel')
    expect(userSettings.modelSettings?.haiku?.contextTokens).toBe(128_000)
  })

  test('the independent default slot is settable', async () => {
    userSettings = {}
    await run('default effort high')
    expect(userSettings.modelSettings?.default?.effort).toBe('high')
    expect(userSettings.modelSettings?.opus).toBeUndefined()
  })

  test('reset drops one slot and reports what is left', async () => {
    userSettings = { modelSettings: { opus: { effort: 'max' } } }
    const output = await run('opus reset')
    expect(output).toStartWith('Cleared overrides for opus. Now: effort=')
    expect(userSettings.modelSettings?.opus).toBeUndefined()
  })

  test('a bad slot, a bad level and a bad count each explain themselves', async () => {
    expect(await run('best effort max')).toContain('best')
    expect(await run('opus effort turbo')).toContain('xhigh')
    expect(await run('opus context huge')).toContain('272k')
    expect(await run('opus')).toStartWith('Usage:')
  })
})

describe('what bare /model-settings opens', () => {
  test('a configurable provider gets the interactive editor', async () => {
    // This is the half that used to require the second command: the wizard step
    // collects the per-tier model ids together with effort and context.
    process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com'
    try {
      const { call } = await import('../model-settings.js')
      const rendered = await call(
        () => {},
        { setAppState: () => {} } as never,
        '',
      )
      expect(isValidElement(rendered)).toBe(true)
    } finally {
      delete process.env.ANTHROPIC_BASE_URL
    }
  })

  test('no configurable provider falls back to the text panel', async () => {
    // buildModelStepFromEnvironment() answers undefined here, which is exactly
    // the bedrock / vertex / foundry / plain-first-party case. Those sessions
    // had a working /model-settings before the merge and must keep one: the
    // text panel is the view that works everywhere, and effort and context are
    // still theirs to set even when the tier models are not.
    const output = await run('')
    expect(output).toStartWith('Model settings (env still wins over these):')
  })
})
