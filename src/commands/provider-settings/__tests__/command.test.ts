/**
 * `/provider` (alias `/api`) and `/provider-settings` (alias `/providers`)
 * used to be two commands over one registry: the first dispatched
 * `save|use|list|delete|models|refresh|aggregate` straight into the second's
 * implementation and owned the provider-FAMILY switch on top. Two rows in
 * /help, one of them a thin wrapper around the other. They are one command
 * now, with every old name kept as an alias.
 *
 * Three things have to stay true for that merge to be safe, and none of them
 * is visible from the parser tests next door:
 *
 *   1. every old name resolves through the real registry, to the SAME command
 *      rather than to a second registration that answers the same name;
 *   2. the family switch — the half that lived only in `/provider` — is still
 *      reachable, and still tells `use <name>` apart from a bare family name;
 *   3. headless runs keep working. `/provider` was a `local` command with
 *      supportsNonInteractive, and the merged command is `local-jsx`, so the
 *      opt-in has to be declared or `-p "/provider save x"` stops resolving.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import {
  builtInCommandNames,
  findCommand,
  type Command,
} from '../../../commands.js'
import { occConfigDir } from '../../../config/paths.js'
import type { SettingsJson } from '../../../utils/settings/types.js'
import providerSettings from '../index.js'
import { runProviderSettingsCommand } from '../actions.js'
import { parseArgs } from '../state.js'

let userSettings: SettingsJson = {}
const settingsMock = setupSettingsMock()

/**
 * Building the built-in registry evaluates /login, which throws outright with
 * no credential present; and a developer on a third-party provider would
 * otherwise get different answers from the family switch. Nothing reads the
 * key — it only has to exist.
 */
const ENV_PINS: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: 'sk-ant-test-registry',
  ANTHROPIC_BASE_URL: undefined,
  OPENAI_BASE_URL: undefined,
  OPENAI_API_KEY: undefined,
  OPENCODE_MODEL: undefined,
  OPENCODE_AUTH_MODE: undefined,
  CLAUDE_CODE_USE_BEDROCK: undefined,
  CLAUDE_CODE_USE_VERTEX: undefined,
  CLAUDE_CODE_USE_FOUNDRY: undefined,
  CLAUDE_CODE_USE_OPENAI: undefined,
  CLAUDE_CODE_USE_GEMINI: undefined,
  CLAUDE_CODE_USE_GROK: undefined,
}
const savedEnv: Record<string, string | undefined> = {}
const savedConfigDir = process.env.OCC_CONFIG_DIR
let tempDir: string | undefined

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV_PINS)) {
    savedEnv[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  settingsMock.set({
    getInitialSettings: () => userSettings,
    getSettings_DEPRECATED: () => userSettings,
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

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  occConfigDir.cache.clear?.()
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
  userSettings = {}
})

function enterTempConfigDir(): void {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-provider-command-'))
  process.env.OCC_CONFIG_DIR = tempDir
  occConfigDir.cache.clear?.()
}

/** Run the argument form exactly as a user typed it, parser included. */
function run(args: string): Promise<string> {
  return runProviderSettingsCommand(parseArgs(args))
}

describe('the merged command surface', () => {
  test('every old name is live in the built-in registry', () => {
    expect(providerSettings.name).toBe('provider-settings')
    const names = builtInCommandNames()
    for (const name of ['provider-settings', 'providers', 'provider', 'api']) {
      expect(names.has(name)).toBe(true)
    }
  })

  test('the old names resolve to this command, through the real lookup', () => {
    // findCommand is what the REPL uses. Before the merge `/provider` was a
    // second registration with its own implementation.
    const commands: Command[] = [providerSettings]
    for (const name of ['provider-settings', 'providers', 'provider', 'api']) {
      expect(findCommand(name, commands)).toBe(providerSettings)
    }
  })

  test('nothing registers a second provider command alongside it', () => {
    // The merge is only a merge if the old command is gone: an alias plus a
    // surviving `/provider` registration would resolve to whichever came first
    // and leave the /help duplication intact.
    const source = readFileSync(
      resolve(import.meta.dir, '..', '..', '..', 'commands.ts'),
      'utf8',
    )
    expect(source).not.toContain('./commands/provider.js')
    expect(source.match(/^\s*provider[A-Za-z]*,$/gm)).toHaveLength(1)
  })

  test('one description covers both axes it now owns', () => {
    // The /help listing showed two rows that read as duplicates. The single
    // row left has to mention profiles as well as the aggregate.
    expect(providerSettings.description).toMatch(/profile/i)
    expect(providerSettings.description).toMatch(/aggregate/i)
    expect(providerSettings.description).toMatch(/add/i)
  })

  test('headless keeps the support `/provider` had', () => {
    // rootAction builds its headless command list from this flag; without it a
    // `-p "/provider list"` run stops recognising the command at all.
    expect(
      (providerSettings as { supportsNonInteractive?: boolean })
        .supportsNonInteractive,
    ).toBe(true)
  })
})

describe('the forms `/provider` owned survive the merge', () => {
  test('a bare family name selects the family', async () => {
    enterTempConfigDir()
    expect(await run('anthropic')).toBe('API provider set to anthropic.')
    expect(userSettings.modelType).toBe('anthropic')
  })

  test('a family that cannot answer yet is still selected, and says why', async () => {
    enterTempConfigDir()
    const output = await run('openai')
    expect(output).toStartWith('Switched to OpenAI provider.')
    expect(output).toContain('OPENAI_API_KEY')
    expect(output).toContain('OPENAI_BASE_URL')
    expect(userSettings.modelType).toBe('openai')
  })

  test('unset falls back to the environment', async () => {
    enterTempConfigDir()
    userSettings = { modelType: 'openai' }
    expect(await run('unset')).toBe(
      'API provider cleared (will use environment variables).',
    )
    expect(userSettings.modelType).toBeUndefined()
  })

  test('a bare family name and `use <name>` are different requests', async () => {
    // A profile really can be called `openai`, and the position is what tells
    // the two apart — the family switch must not shadow the profile.
    expect(parseArgs('openai')).toEqual({
      kind: 'set-provider',
      provider: 'openai',
    })
    expect(parseArgs('use openai')).toEqual({ kind: 'use', name: 'openai' })
  })

  test('the listing still leads with the line bare /provider printed', async () => {
    enterTempConfigDir()
    const output = await run('list')
    expect(output).toStartWith('Current API provider: ')
    expect(output).toContain('No saved provider profiles yet')
  })

  test('an unknown argument names the families it accepts', async () => {
    enterTempConfigDir()
    const output = await run('frobnicate')
    expect(output).toContain('"frobnicate"')
    expect(output).toContain('bedrock')
    expect(output).toContain('unset')
  })
})
