/**
 * No mocks: the registry is redirected with OCC_CONFIG_DIR (occConfigDir's
 * memo is keyed on that env pair, so a temp dir really does take effect) and
 * the network is supplied through the fetchImpl seam fetchExplicit already
 * exposes for exactly this. Mocking the fs or the fetcher here would test the
 * mock rather than the derivation this module exists for.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ProviderProfile,
  ProviderProfilesFile,
} from 'src/services/providerProfiles/profiles.js'
import {
  catalogBaseURLForProfile,
  catalogWireForProfile,
  refreshProfileCatalog,
} from '../catalogRefresh.js'

function profile(params: {
  name: string
  modelType?: string
  env?: Record<string, string>
}): ProviderProfile {
  return {
    name: params.name,
    modelType: (params.modelType ?? 'openai') as ProviderProfile['modelType'],
    env: params.env ?? {},
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  }
}

describe('catalogWireForProfile', () => {
  test('the recorded modelType is the default answer', () => {
    expect(catalogWireForProfile(profile({ name: 'p' }))).toBe('openai')
    expect(
      catalogWireForProfile(profile({ name: 'p', modelType: 'anthropic' })),
    ).toBe('anthropic')
    expect(
      catalogWireForProfile(profile({ name: 'p', modelType: 'gemini' })),
    ).toBe('gemini')
    // Grok's API is OpenAI-compatible, including its model list.
    expect(
      catalogWireForProfile(profile({ name: 'p', modelType: 'grok' })),
    ).toBe('openai')
  })

  test('a saved lane outranks the modelType', () => {
    // Nothing here names OpenCode: the profile says which lane it speaks and
    // this reads it, so a family added later needs no edit.
    expect(
      catalogWireForProfile(
        profile({
          name: 'zen',
          modelType: 'opencode',
          env: { OPENCODE_WIRE_API: 'messages' },
        }),
      ),
    ).toBe('anthropic')
    expect(
      catalogWireForProfile(
        profile({
          name: 'zen',
          modelType: 'opencode',
          env: { OPENCODE_WIRE_API: 'chat' },
        }),
      ),
    ).toBe('openai')
    expect(
      catalogWireForProfile(
        profile({
          name: 'p',
          modelType: 'anthropic',
          env: { OPENAI_WIRE_API: 'responses' },
        }),
      ),
    ).toBe('openai')
  })

  test('an unrecognised lane falls back rather than guessing', () => {
    expect(
      catalogWireForProfile(
        profile({
          name: 'p',
          modelType: 'anthropic',
          env: { OPENAI_WIRE_API: 'telepathy' },
        }),
      ),
    ).toBe('anthropic')
  })
})

describe('catalogBaseURLForProfile', () => {
  test('a built-in family falls back to its public endpoint', () => {
    expect(
      catalogBaseURLForProfile(profile({ name: 'p', modelType: 'anthropic' })),
    ).toBe('https://api.anthropic.com')
  })

  test('the profile’s own endpoint wins', () => {
    expect(
      catalogBaseURLForProfile(
        profile({
          name: 'p',
          env: { OPENAI_BASE_URL: 'https://relay.example/v1' },
        }),
      ),
    ).toBe('https://relay.example/v1')
  })

  test('a family with no built-in default uses the endpoint it saved', () => {
    expect(
      catalogBaseURLForProfile(
        profile({
          name: 'zen',
          modelType: 'opencode',
          env: { OPENCODE_BASE_URL: 'https://opencode.ai/zen/v1' },
        }),
      ),
    ).toBe('https://opencode.ai/zen/v1')
  })

  test('a family with neither is null, not a guess', () => {
    expect(
      catalogBaseURLForProfile(profile({ name: 'zen', modelType: 'opencode' })),
    ).toBeNull()
  })
})

describe('refreshProfileCatalog', () => {
  let dir: string
  let savedConfigDir: string | undefined
  let savedLegacyDir: string | undefined

  const registryPath = (): string => join(dir, 'provider-profiles.json')

  function writeRegistry(file: ProviderProfilesFile): void {
    writeFileSync(registryPath(), JSON.stringify(file, null, 2))
  }

  function readRegistry(): ProviderProfilesFile {
    return JSON.parse(
      readFileSync(registryPath(), 'utf8'),
    ) as ProviderProfilesFile
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'occ-provider-settings-'))
    savedConfigDir = process.env.OCC_CONFIG_DIR
    savedLegacyDir = process.env.CLAUDE_CONFIG_DIR
    process.env.OCC_CONFIG_DIR = dir
    delete process.env.CLAUDE_CONFIG_DIR
  })

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
    else process.env.OCC_CONFIG_DIR = savedConfigDir
    if (savedLegacyDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedLegacyDir
    rmSync(dir, { recursive: true, force: true })
  })

  test('writes the fetched list into the profile, credentials untouched', async () => {
    writeRegistry({
      version: 1,
      profiles: {
        relay: profile({
          name: 'relay',
          modelType: 'anthropic',
          env: {
            ANTHROPIC_BASE_URL: 'https://relay.example',
            ANTHROPIC_API_KEY: 'sk-relay',
          },
        }),
      },
    })

    const seen: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      seen.push(String(url))
      return new Response(
        JSON.stringify({
          data: [
            { id: 'claude-opus-5', display_name: 'Opus 5' },
            { id: 'claude-haiku-4-5' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const result = await refreshProfileCatalog('relay', { fetchImpl })
    expect(result).toMatchObject({
      models: [
        { id: 'claude-opus-5', displayName: 'Opus 5' },
        { id: 'claude-haiku-4-5' },
      ],
    })
    expect(seen[0]).toContain('https://relay.example/v1/models')

    const saved = readRegistry().profiles.relay!
    expect(saved.models?.map(m => m.id)).toEqual([
      'claude-opus-5',
      'claude-haiku-4-5',
    ])
    // A catalog refresh must not re-snapshot credentials: the env it had
    // before is the env it has after.
    expect(saved.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://relay.example',
      ANTHROPIC_API_KEY: 'sk-relay',
    })
    // Opting in stays a separate, explicit decision.
    expect(saved.aggregate).toBeUndefined()
  })

  test('an unknown profile is an error, not a silent no-op', async () => {
    writeRegistry({ version: 1, profiles: {} })
    expect(await refreshProfileCatalog('nope')).toEqual({
      error: 'Unknown profile "nope".',
    })
  })

  test('a profile with no saved key says so instead of hitting the network', async () => {
    writeRegistry({
      version: 1,
      profiles: {
        oauth: profile({ name: 'oauth', modelType: 'anthropic' }),
      },
    })
    let called = false
    const fetchImpl = (async () => {
      called = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const result = await refreshProfileCatalog('oauth', { fetchImpl })
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('no API key')
    expect(called).toBe(false)
  })

  test('an endpoint failure is reported with its reason and writes nothing', async () => {
    writeRegistry({
      version: 1,
      profiles: {
        relay: profile({
          name: 'relay',
          modelType: 'anthropic',
          env: {
            ANTHROPIC_BASE_URL: 'https://relay.example',
            ANTHROPIC_API_KEY: 'sk-relay',
          },
        }),
      },
    })
    const fetchImpl = (async () =>
      new Response('nope', { status: 401 })) as unknown as typeof fetch

    const result = await refreshProfileCatalog('relay', { fetchImpl })
    expect((result as { error: string }).error).toContain('HTTP 401')
    expect(readRegistry().profiles.relay!.models).toBeUndefined()
  })
})
