import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PROFILE_ENV_KEYS, type ProfileModelType } from '../envKeys.js'
import {
  ALL_PROFILE_ENV_KEYS,
  buildActivationEnvPatch,
  captureProfile,
  isValidProfileName,
  loadProfilesFile,
  profilesFilePath,
  saveProfilesFile,
} from '../profiles.js'

const EXPECTED_TIER_ENV_KEYS: Record<ProfileModelType, readonly string[]> = {
  anthropic: [
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
    'ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION',
    'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
    'ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION',
    'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
    'ANTHROPIC_DEFAULT_FABLE_MODEL',
    'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
    'ANTHROPIC_DEFAULT_FABLE_MODEL_DESCRIPTION',
    'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  ],
  openai: [
    'OPENAI_DEFAULT_HAIKU_MODEL',
    'OPENAI_DEFAULT_HAIKU_MODEL_NAME',
    'OPENAI_DEFAULT_HAIKU_MODEL_DESCRIPTION',
    'OPENAI_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
    'OPENAI_DEFAULT_SONNET_MODEL',
    'OPENAI_DEFAULT_SONNET_MODEL_NAME',
    'OPENAI_DEFAULT_SONNET_MODEL_DESCRIPTION',
    'OPENAI_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
    'OPENAI_DEFAULT_OPUS_MODEL',
    'OPENAI_DEFAULT_OPUS_MODEL_NAME',
    'OPENAI_DEFAULT_OPUS_MODEL_DESCRIPTION',
    'OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
    'OPENAI_DEFAULT_FABLE_MODEL',
    'OPENAI_DEFAULT_FABLE_MODEL_NAME',
    'OPENAI_DEFAULT_FABLE_MODEL_DESCRIPTION',
    'OPENAI_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  ],
  gemini: [
    'GEMINI_DEFAULT_HAIKU_MODEL',
    'GEMINI_DEFAULT_HAIKU_MODEL_NAME',
    'GEMINI_DEFAULT_HAIKU_MODEL_DESCRIPTION',
    'GEMINI_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
    'GEMINI_DEFAULT_SONNET_MODEL',
    'GEMINI_DEFAULT_SONNET_MODEL_NAME',
    'GEMINI_DEFAULT_SONNET_MODEL_DESCRIPTION',
    'GEMINI_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
    'GEMINI_DEFAULT_OPUS_MODEL',
    'GEMINI_DEFAULT_OPUS_MODEL_NAME',
    'GEMINI_DEFAULT_OPUS_MODEL_DESCRIPTION',
    'GEMINI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
    'GEMINI_DEFAULT_FABLE_MODEL',
    'GEMINI_DEFAULT_FABLE_MODEL_NAME',
    'GEMINI_DEFAULT_FABLE_MODEL_DESCRIPTION',
    'GEMINI_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  ],
  grok: [
    'GROK_DEFAULT_HAIKU_MODEL',
    'GROK_DEFAULT_HAIKU_MODEL_NAME',
    'GROK_DEFAULT_HAIKU_MODEL_DESCRIPTION',
    'GROK_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
    'GROK_DEFAULT_SONNET_MODEL',
    'GROK_DEFAULT_SONNET_MODEL_NAME',
    'GROK_DEFAULT_SONNET_MODEL_DESCRIPTION',
    'GROK_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
    'GROK_DEFAULT_OPUS_MODEL',
    'GROK_DEFAULT_OPUS_MODEL_NAME',
    'GROK_DEFAULT_OPUS_MODEL_DESCRIPTION',
    'GROK_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
    'GROK_DEFAULT_FABLE_MODEL',
    'GROK_DEFAULT_FABLE_MODEL_NAME',
    'GROK_DEFAULT_FABLE_MODEL_DESCRIPTION',
    'GROK_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  ],
}

describe('PROFILE_ENV_KEYS', () => {
  test('includes every tier model field for every provider family', () => {
    for (const modelType of Object.keys(
      EXPECTED_TIER_ENV_KEYS,
    ) as ProfileModelType[]) {
      expect(PROFILE_ENV_KEYS[modelType]).toEqual(
        expect.arrayContaining(EXPECTED_TIER_ENV_KEYS[modelType]),
      )
    }
    expect(ALL_PROFILE_ENV_KEYS).toEqual(
      expect.arrayContaining(Object.values(EXPECTED_TIER_ENV_KEYS).flat()),
    )
  })
})

describe('isValidProfileName', () => {
  test('accepts shell-friendly names', () => {
    expect(isValidProfileName('deepseek')).toBe(true)
    expect(isValidProfileName('my-provider.v2_test')).toBe(true)
  })

  test('rejects empty, leading-punctuation, and spaced names', () => {
    expect(isValidProfileName('')).toBe(false)
    expect(isValidProfileName('-lead')).toBe(false)
    expect(isValidProfileName('has space')).toBe(false)
    expect(isValidProfileName('a'.repeat(65))).toBe(false)
  })
})

describe('captureProfile', () => {
  test('snapshots only the keys of the profile modelType', () => {
    const profile = captureProfile({
      name: 'ds',
      modelType: 'openai',
      mergedEnv: {
        OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
        OPENAI_API_KEY: 'sk-x',
        GEMINI_API_KEY: 'should-not-be-captured',
        PATH: '/usr/bin',
      },
    })

    expect(profile.env).toEqual({
      OPENAI_BASE_URL: 'https://api.deepseek.com/v1',
      OPENAI_API_KEY: 'sk-x',
    })
  })

  test('captures tier model metadata and capability overrides', () => {
    const profile = captureProfile({
      name: 'custom',
      modelType: 'openai',
      mergedEnv: {
        OPENAI_DEFAULT_OPUS_MODEL: 'shared-model',
        OPENAI_DEFAULT_OPUS_MODEL_NAME: 'Profile A Opus',
        OPENAI_DEFAULT_OPUS_MODEL_DESCRIPTION: 'Profile A description',
        OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: 'thinking,effort',
      },
    })

    expect(profile.env).toEqual({
      OPENAI_DEFAULT_OPUS_MODEL: 'shared-model',
      OPENAI_DEFAULT_OPUS_MODEL_NAME: 'Profile A Opus',
      OPENAI_DEFAULT_OPUS_MODEL_DESCRIPTION: 'Profile A description',
      OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES: 'thinking,effort',
    })
  })

  test('preserves createdAt across re-saves', () => {
    const first = captureProfile({
      name: 'p',
      modelType: 'anthropic',
      mergedEnv: {},
    })
    const second = captureProfile({
      name: 'p',
      modelType: 'anthropic',
      mergedEnv: { ANTHROPIC_BASE_URL: 'https://x' },
      existing: first,
    })
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.env.ANTHROPIC_BASE_URL).toBe('https://x')
  })

  test('drops empty-string values', () => {
    const profile = captureProfile({
      name: 'p',
      modelType: 'grok',
      mergedEnv: { GROK_API_KEY: '', XAI_API_KEY: 'xai-1' },
    })
    expect(profile.env).toEqual({ XAI_API_KEY: 'xai-1' })
  })
})

describe('buildActivationEnvPatch', () => {
  test('clears every managed key, then overlays the profile env', () => {
    const patch = buildActivationEnvPatch({
      name: 'ds',
      modelType: 'openai',
      env: { OPENAI_API_KEY: 'sk-x' },
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    })

    // whole-shape write: keys of OTHER providers are explicitly deleted
    expect(patch.GEMINI_API_KEY).toBeUndefined()
    expect('GEMINI_API_KEY' in patch).toBe(true)
    expect('ANTHROPIC_BASE_URL' in patch).toBe(true)
    expect(patch.OPENAI_API_KEY).toBe('sk-x')
    expect(patch.OPENAI_DEFAULT_OPUS_MODEL_NAME).toBeUndefined()
    expect('OPENAI_DEFAULT_OPUS_MODEL_NAME' in patch).toBe(true)
    expect(patch.OPENAI_DEFAULT_OPUS_MODEL_DESCRIPTION).toBeUndefined()
    expect('OPENAI_DEFAULT_OPUS_MODEL_DESCRIPTION' in patch).toBe(true)
    expect(
      patch.OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES,
    ).toBeUndefined()
    expect('OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES' in patch).toBe(
      true,
    )
    expect(Object.keys(patch).length).toBe(ALL_PROFILE_ENV_KEYS.length)
  })

  test('an empty anthropic profile clears all third-party overrides (OAuth fallback)', () => {
    const patch = buildActivationEnvPatch({
      name: 'claude-oauth',
      modelType: 'anthropic',
      env: {},
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    })
    expect(Object.values(patch).every(v => v === undefined)).toBe(true)
  })
})

describe('profiles file roundtrip', () => {
  const savedConfigDir = process.env.OCC_CONFIG_DIR
  let tempDir: string | undefined

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
    else process.env.OCC_CONFIG_DIR = savedConfigDir
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  test('load missing file → empty registry; save → load roundtrip; 0600 perms', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'occ-profiles-'))
    process.env.OCC_CONFIG_DIR = tempDir

    expect(loadProfilesFile()).toEqual({ version: 1, profiles: {} })

    const profile = captureProfile({
      name: 'ds',
      modelType: 'openai',
      mergedEnv: { OPENAI_API_KEY: 'sk-x' },
    })
    saveProfilesFile({ version: 1, active: 'ds', profiles: { ds: profile } })

    const loaded = loadProfilesFile()
    expect(loaded.active).toBe('ds')
    expect(loaded.profiles.ds?.env.OPENAI_API_KEY).toBe('sk-x')

    if (process.platform !== 'win32') {
      const mode = statSync(profilesFilePath()).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  test('corrupt file fails soft to an empty registry', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'occ-profiles-'))
    process.env.OCC_CONFIG_DIR = tempDir
    saveProfilesFile({ version: 1, profiles: {} })
    // overwrite with garbage via the same path helper
    const { writeFileSync } = require('fs') as typeof import('fs')
    writeFileSync(profilesFilePath(), '{not json', 'utf8')
    expect(loadProfilesFile()).toEqual({ version: 1, profiles: {} })
  })
})
