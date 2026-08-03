/**
 * Default marketplace behavior — the official Claude Code repo
 * (anthropics/claude-code, manifest name 'claude-code-plugins') is declared
 * as a constant fallback for users with no marketplace configuration, and
 * removal is made sticky via a tombstone marker in the plugins state dir.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'
import * as realSettings from 'src/utils/settings/settings.js'
import type { SettingsJson } from 'src/utils/settings/types.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

// Complete-surface settings mock: only the two reads that feed the
// declaration layer are overridden; everything else delegates to the real
// module so later files never see a partial surface.
let mockSettings: SettingsJson = {}
let mockPolicySettings: SettingsJson | null = null
makeSharedModuleMock('src/utils/settings/settings.js', realSettings).setup({
  getInitialSettings: () => mockSettings,
  getSettingsForSource: source =>
    source === 'policySettings' ? mockPolicySettings : null,
})

const {
  DEFAULT_MARKETPLACE_NAME,
  DEFAULT_MARKETPLACE_SOURCE,
  OFFICIAL_MARKETPLACE_NAME,
} = await import('../officialMarketplace.js')
const {
  getDeclaredMarketplaces,
  isDefaultMarketplaceRemoved,
  isOfficialMarketplaceRemoved,
  removeMarketplaceSource,
} = await import('../marketplaceManager.js')
const { diffMarketplaces } = await import('../reconciler.js')

const TOMBSTONE_FILE = '.default_marketplace_removed'
const OFFICIAL_TOMBSTONE_FILE = '.official_marketplace_removed'

const envNames = [
  'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL',
  'CLAUDE_CODE_PLUGIN_SEED_DIR',
  'OCC_PLUGIN_CACHE_DIR',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
] as const
const savedEnv = new Map<string, string | undefined>()

// Isolated plugins state dir per test — the tombstone marker and
// known_marketplaces.json both live under it.
let pluginsDir = ''

beforeEach(() => {
  for (const name of envNames) {
    savedEnv.set(name, process.env[name])
    delete process.env[name]
  }
  mockSettings = {}
  mockPolicySettings = null
  pluginsDir = join(
    tmpdir(),
    `occ-default-marketplace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(pluginsDir, { recursive: true })
  process.env.OCC_PLUGIN_CACHE_DIR = pluginsDir
})

afterEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true })
  for (const name of envNames) {
    const value = savedEnv.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  savedEnv.clear()
})

describe('getDeclaredMarketplaces default entry', () => {
  test('declares the default marketplace when the user has no marketplace config', () => {
    const declared = getDeclaredMarketplaces()
    expect(declared[DEFAULT_MARKETPLACE_NAME]).toEqual({
      source: { source: 'github', repo: 'anthropics/claude-code' },
      sourceIsFallback: true,
    })
  })

  test('does not declare the default when settings declare any marketplace', () => {
    mockSettings = {
      extraKnownMarketplaces: {
        'my-marketplace': {
          source: { source: 'github', repo: 'me/my-plugins' },
        },
      },
    }
    const declared = getDeclaredMarketplaces()
    expect(declared[DEFAULT_MARKETPLACE_NAME]).toBeUndefined()
    expect(declared['my-marketplace']).toBeDefined()
  })

  test('an explicit settings entry under the same name wins over the fallback', () => {
    mockSettings = {
      extraKnownMarketplaces: {
        [DEFAULT_MARKETPLACE_NAME]: {
          source: { source: 'github', repo: 'anthropics/claude-code-mirror' },
        },
      },
    }
    const declared = getDeclaredMarketplaces()
    expect(declared[DEFAULT_MARKETPLACE_NAME]).toEqual({
      source: { source: 'github', repo: 'anthropics/claude-code-mirror' },
    })
    expect(declared[DEFAULT_MARKETPLACE_NAME]?.sourceIsFallback).toBeUndefined()
  })

  test('respects CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL', () => {
    process.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = '1'
    expect(getDeclaredMarketplaces()[DEFAULT_MARKETPLACE_NAME]).toBeUndefined()
  })

  test('respects an enterprise policy allowlist that excludes the default', () => {
    mockPolicySettings = {
      strictKnownMarketplaces: [
        { source: 'github', repo: 'mycompany/approved-plugins' },
      ],
    }
    expect(getDeclaredMarketplaces()[DEFAULT_MARKETPLACE_NAME]).toBeUndefined()
  })

  test('respects the removal tombstone marker', () => {
    writeFileSync(join(pluginsDir, TOMBSTONE_FILE), '{}')
    expect(isDefaultMarketplaceRemoved()).toBe(true)
    expect(getDeclaredMarketplaces()[DEFAULT_MARKETPLACE_NAME]).toBeUndefined()
  })

  test('coexists with the implicit official marketplace declaration', () => {
    mockSettings = {
      enabledPlugins: { [`some-plugin@${OFFICIAL_MARKETPLACE_NAME}`]: true },
    }
    const declared = getDeclaredMarketplaces()
    expect(declared[DEFAULT_MARKETPLACE_NAME]).toBeDefined()
    expect(declared[OFFICIAL_MARKETPLACE_NAME]).toBeDefined()
  })

  test('fallback entry never reports sourceChanged for a materialized entry', () => {
    // Already materialized under a different source (seed/mirror/prior add):
    // presence suffices — no re-clone, no stomp, nothing written back.
    const declared = getDeclaredMarketplaces()
    const diff = diffMarketplaces(declared, {
      [DEFAULT_MARKETPLACE_NAME]: {
        source: {
          source: 'git',
          url: 'https://mirror.example/claude-code.git',
        },
        installLocation: '/somewhere/claude-code-plugins',
        lastUpdated: new Date().toISOString(),
      },
    })
    expect(diff.upToDate).toContain(DEFAULT_MARKETPLACE_NAME)
    expect(diff.missing).not.toContain(DEFAULT_MARKETPLACE_NAME)
    expect(diff.sourceChanged).toEqual([])
  })
})

describe('getDeclaredMarketplaces official entry', () => {
  test('declares the official marketplace unconditionally for a fresh install', () => {
    const declared = getDeclaredMarketplaces()
    expect(declared[OFFICIAL_MARKETPLACE_NAME]).toEqual({
      source: { source: 'github', repo: 'anthropics/claude-plugins-official' },
      sourceIsFallback: true,
    })
  })

  test('still declares the official marketplace when the user has their own marketplaces', () => {
    mockSettings = {
      extraKnownMarketplaces: {
        'my-marketplace': {
          source: { source: 'github', repo: 'me/my-plugins' },
        },
      },
    }
    expect(getDeclaredMarketplaces()[OFFICIAL_MARKETPLACE_NAME]).toBeDefined()
  })

  test('respects CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL', () => {
    process.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = '1'
    expect(getDeclaredMarketplaces()[OFFICIAL_MARKETPLACE_NAME]).toBeUndefined()
  })

  test('an enabled plugin re-declares it even when auto-install is disabled', () => {
    process.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL = '1'
    mockSettings = {
      enabledPlugins: { [`some-plugin@${OFFICIAL_MARKETPLACE_NAME}`]: true },
    }
    expect(getDeclaredMarketplaces()[OFFICIAL_MARKETPLACE_NAME]).toBeDefined()
  })

  test('respects an enterprise policy allowlist that excludes it', () => {
    mockPolicySettings = {
      strictKnownMarketplaces: [
        { source: 'github', repo: 'mycompany/approved-plugins' },
      ],
    }
    expect(getDeclaredMarketplaces()[OFFICIAL_MARKETPLACE_NAME]).toBeUndefined()
  })

  test('respects the removal tombstone marker', () => {
    writeFileSync(join(pluginsDir, OFFICIAL_TOMBSTONE_FILE), '{}')
    expect(isOfficialMarketplaceRemoved()).toBe(true)
    expect(getDeclaredMarketplaces()[OFFICIAL_MARKETPLACE_NAME]).toBeUndefined()
    // The two tombstones are independent — default stays declared.
    expect(getDeclaredMarketplaces()[DEFAULT_MARKETPLACE_NAME]).toBeDefined()
  })
})

describe('removeMarketplaceSource tombstone', () => {
  function writeKnownMarketplaces(names: string[]): void {
    const entries: Record<string, unknown> = {}
    for (const name of names) {
      mkdirSync(join(pluginsDir, 'marketplaces', name), { recursive: true })
      entries[name] = {
        source: DEFAULT_MARKETPLACE_SOURCE,
        installLocation: join(pluginsDir, 'marketplaces', name),
        lastUpdated: new Date().toISOString(),
      }
    }
    writeFileSync(
      join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify(entries, null, 2),
    )
  }

  test('removing the default marketplace writes the tombstone and stops the declaration', async () => {
    writeKnownMarketplaces([DEFAULT_MARKETPLACE_NAME])
    expect(getDeclaredMarketplaces()[DEFAULT_MARKETPLACE_NAME]).toBeDefined()

    await removeMarketplaceSource(DEFAULT_MARKETPLACE_NAME)

    expect(existsSync(join(pluginsDir, TOMBSTONE_FILE))).toBe(true)
    expect(isDefaultMarketplaceRemoved()).toBe(true)
    // Not re-declared → the reconciler will not write it back on startup.
    expect(getDeclaredMarketplaces()[DEFAULT_MARKETPLACE_NAME]).toBeUndefined()
  })

  test('removing the official marketplace writes its own tombstone and stops the declaration', async () => {
    writeKnownMarketplaces([OFFICIAL_MARKETPLACE_NAME])
    expect(getDeclaredMarketplaces()[OFFICIAL_MARKETPLACE_NAME]).toBeDefined()

    await removeMarketplaceSource(OFFICIAL_MARKETPLACE_NAME)

    expect(existsSync(join(pluginsDir, OFFICIAL_TOMBSTONE_FILE))).toBe(true)
    expect(isOfficialMarketplaceRemoved()).toBe(true)
    expect(getDeclaredMarketplaces()[OFFICIAL_MARKETPLACE_NAME]).toBeUndefined()
    // Default tombstone untouched — the default marketplace stays declared.
    expect(existsSync(join(pluginsDir, TOMBSTONE_FILE))).toBe(false)
    expect(getDeclaredMarketplaces()[DEFAULT_MARKETPLACE_NAME]).toBeDefined()
  })

  test('removing an unrelated marketplace leaves the tombstone unset', async () => {
    writeKnownMarketplaces(['other-marketplace'])

    await removeMarketplaceSource('other-marketplace')

    expect(existsSync(join(pluginsDir, TOMBSTONE_FILE))).toBe(false)
    expect(isDefaultMarketplaceRemoved()).toBe(false)
    expect(getDeclaredMarketplaces()[DEFAULT_MARKETPLACE_NAME]).toBeDefined()
  })
})
