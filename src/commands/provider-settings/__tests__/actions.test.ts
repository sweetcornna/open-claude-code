/**
 * The argument surface, run against a real registry in a temp config dir — the
 * same seam catalogRefresh.test.ts uses, and for the same reason: mocking the
 * registry here would test the mock rather than the wiring between parseArgs,
 * the pure describers and the profile store.
 *
 * Only the verbs that stay inside the registry are exercised. `use` activates,
 * which writes settings.json and clears client caches, and that belongs to
 * activate.test.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { occConfigDir } from 'src/config/paths.js'
import {
  loadProfilesFile,
  saveProfilesFile,
  type ProviderProfile,
} from 'src/services/providerProfiles/profiles.js'
import { runProviderSettingsCommand } from '../actions.js'
import { parseArgs } from '../state.js'

const savedConfigDir = process.env.OCC_CONFIG_DIR
let tempDir: string | undefined

function enterTempConfigDir(): void {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-provider-settings-'))
  process.env.OCC_CONFIG_DIR = tempDir
  occConfigDir.cache.clear?.()
}

function profile(params: {
  name: string
  aggregate?: boolean
  models?: { id: string }[]
  env?: Record<string, string>
}): ProviderProfile {
  return {
    name: params.name,
    modelType: 'openai',
    env: params.env ?? {},
    ...(params.models !== undefined ? { models: params.models } : {}),
    ...(params.aggregate !== undefined ? { aggregate: params.aggregate } : {}),
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  }
}

/** Run the verb exactly as a user typed it, parser included. */
function run(args: string): Promise<string> {
  return runProviderSettingsCommand(parseArgs(args))
}

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  occConfigDir.cache.clear?.()
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('rename', () => {
  test('moves the profile and reports the active pointer moving with it', async () => {
    enterTempConfigDir()
    saveProfilesFile({
      version: 1,
      active: 'relay',
      profiles: { relay: profile({ name: 'relay' }) },
    })

    expect(await run('rename relay zen')).toBe(
      'Renamed "relay" to "zen". It is still the active profile.',
    )
    expect(loadProfilesFile()).toMatchObject({
      active: 'zen',
      profiles: { zen: { name: 'zen' } },
    })
  })

  test('a collision is refused and changes nothing', async () => {
    enterTempConfigDir()
    saveProfilesFile({
      version: 1,
      profiles: {
        relay: profile({ name: 'relay' }),
        zen: profile({ name: 'zen', env: { OPENAI_API_KEY: 'sk-zen' } }),
      },
    })

    expect(await run('rename relay zen')).toContain('already exists')
    expect(loadProfilesFile().profiles.zen?.env.OPENAI_API_KEY).toBe('sk-zen')
  })
})

describe('overview', () => {
  test('prints the headline, the contributors and the shared ids', async () => {
    enterTempConfigDir()
    saveProfilesFile({
      version: 1,
      profiles: {
        official: profile({
          name: 'official',
          aggregate: true,
          models: [{ id: 'gpt-5.4' }],
          env: { OPENAI_API_KEY: 'sk-official' },
        }),
        relay: profile({
          name: 'relay',
          aggregate: true,
          models: [{ id: 'gpt-5.4' }, { id: 'glm-5' }],
        }),
      },
    })

    const text = await run('overview')
    expect(text).toContain('3 models from 2 profile(s)')
    expect(text).toContain('official 1')
    expect(text).toContain('relay 2')
    expect(text).toContain('shared ids: gpt-5.4 (official, relay)')
    // Same rule as the listing: presence of a key is reportable, the key and
    // the name of the variable holding it are not.
    expect(text).not.toContain('sk-official')
    expect(text).not.toContain('OPENAI_API_KEY')
  })
})

describe('add', () => {
  test('explains the interactive path instead of taking a credential', async () => {
    enterTempConfigDir()
    saveProfilesFile({ version: 1, profiles: {} })

    const text = await run('add')
    expect(text).toContain('press A')
    expect(text).toContain('/provider-settings save <name>')
    expect(text).not.toContain('API_KEY')
  })

  test('checks a proposed name against the registry', async () => {
    enterTempConfigDir()
    saveProfilesFile({
      version: 1,
      profiles: { relay: profile({ name: 'relay' }) },
    })

    expect(await run('add relay')).toContain('already exists')
    expect(await run('add zen')).toContain('The name "zen" is free.')
  })
})
