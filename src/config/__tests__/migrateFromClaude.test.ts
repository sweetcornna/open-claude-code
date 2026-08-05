import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import {
  AUTH_BEARING_ACCOUNT_KEYS,
  buildGlobalConfigMerge,
  describeMigrationPlan,
  type FsProbe,
  isCredentialEnvKey,
  LEGACY_ACCOUNT_CONFIG_KEYS,
  resolveCredentialOutcome,
  isMigrationSuppressed,
  MIGRATED_DIRECTORIES,
  MIGRATED_FILES,
  MIGRATION_MARKER,
  NEVER_MIGRATED,
  planHasWork,
  planMigrationFromClaude,
  readLegacyMcpServers,
  readMigrationMarker,
  restoreStrippedSettings,
  stripCredentialsFromMcpServers,
  stripCredentialsFromSettings,
} from '../migrateFromClaude.js'
import { occConfigDir } from '../paths.js'

const OCC = 'OCC_CONFIG_DIR'
const LEGACY = 'CLAUDE_CONFIG_DIR'
const SKIP = 'OCC_SKIP_MIGRATION'

const CLAUDE_DIR = join(homedir(), '.claude').normalize('NFC')

let saved: Record<string, string | undefined> = {}

function reset(): void {
  delete process.env[OCC]
  delete process.env[LEGACY]
  delete process.env[SKIP]
  occConfigDir.cache.clear?.()
}

/** In-memory filesystem: a set of paths, and which of them are directories. */
function makeFs(files: Record<string, string>, dirs: string[] = []): FsProbe {
  const dirSet = new Set(dirs)
  return {
    exists: p => p in files || dirSet.has(p),
    isDirectory: p => dirSet.has(p),
    readFile: p => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`)
      return files[p] as string
    },
  }
}

beforeEach(() => {
  saved = {
    [OCC]: process.env[OCC],
    [LEGACY]: process.env[LEGACY],
    [SKIP]: process.env[SKIP],
  }
  reset()
})

afterEach(() => {
  reset()
  for (const [k, v] of Object.entries(saved)) {
    if (v !== undefined) process.env[k] = v
  }
  occConfigDir.cache.clear?.()
})

describe('planMigrationFromClaude', () => {
  test('reports nothing to do when there is no legacy directory', () => {
    const plan = planMigrationFromClaude(makeFs({}))
    expect(plan.sourceExists).toBe(false)
    expect(plan.items).toEqual([])
    expect(planHasWork(plan)).toBe(false)
  })

  test('plans a copy for each authored directory that is present', () => {
    const plan = planMigrationFromClaude(
      makeFs({}, [
        CLAUDE_DIR,
        join(CLAUDE_DIR, 'skills'),
        join(CLAUDE_DIR, 'agents'),
      ]),
    )
    expect(plan.sourceExists).toBe(true)
    expect(plan.items.map(i => i.name).sort()).toEqual(['agents', 'skills'])
    expect(plan.items.every(i => i.kind === 'dir')).toBe(true)
  })

  // Credentials may now be MIGRATED (into occ's own secure storage), but they
  // are still never COPIED as files: the credential file and the whole session
  // history stay out of the item list in both modes.
  test('never plans to copy credential files or session history', () => {
    // Populate the legacy dir with everything, including the forbidden paths.
    const dirs = [
      CLAUDE_DIR,
      ...MIGRATED_DIRECTORIES.map(d => join(CLAUDE_DIR, d)),
      ...NEVER_MIGRATED.map(d => join(CLAUDE_DIR, d)),
    ]
    const files: Record<string, string> = {}
    for (const f of MIGRATED_FILES) files[join(CLAUDE_DIR, f)] = '{}'
    for (const f of NEVER_MIGRATED) files[join(CLAUDE_DIR, f)] = 'secret'

    for (const migrateCredentials of [false, true]) {
      const plan = planMigrationFromClaude(makeFs(files, dirs), {
        migrateCredentials,
      })
      const planned = new Set(plan.items.map(i => i.name))
      for (const forbidden of NEVER_MIGRATED) {
        expect(planned.has(forbidden)).toBe(false)
      }
      // and specifically the credential file
      expect(planned.has('.credentials.json')).toBe(false)
      expect(planned.has('projects')).toBe(false)
    }
  })

  test('is idempotent — the marker short-circuits a second run', () => {
    process.env[OCC] = '/tmp/occ-migrated'
    occConfigDir.cache.clear?.()
    const fs = makeFs({ [join('/tmp/occ-migrated', MIGRATION_MARKER)]: '' }, [
      CLAUDE_DIR,
      join(CLAUDE_DIR, 'skills'),
    ])
    const plan = planMigrationFromClaude(fs)
    expect(plan.alreadyMigrated).toBe(true)
    expect(plan.items).toEqual([])
    expect(planHasWork(plan)).toBe(false)
  })

  test('never clobbers a destination that already exists', () => {
    process.env[OCC] = '/tmp/occ-existing'
    occConfigDir.cache.clear?.()
    const plan = planMigrationFromClaude(
      makeFs({}, [
        CLAUDE_DIR,
        join(CLAUDE_DIR, 'skills'),
        join(CLAUDE_DIR, 'agents'),
        // skills already exists on the occ side
        join('/tmp/occ-existing', 'skills'),
      ]),
    )
    expect(plan.items.map(i => i.name)).toEqual(['agents'])
  })

  test('refuses to migrate a directory onto itself', () => {
    // A user pointing OCC_CONFIG_DIR at ~/.claude would otherwise make the
    // copy read and write the same tree.
    process.env[OCC] = CLAUDE_DIR
    occConfigDir.cache.clear?.()
    const plan = planMigrationFromClaude(
      makeFs({}, [CLAUDE_DIR, join(CLAUDE_DIR, 'skills')]),
    )
    expect(plan.items).toEqual([])
  })
})

describe('readLegacyMcpServers', () => {
  test('extracts mcpServers from the legacy global config', () => {
    const legacyGlobal = join(CLAUDE_DIR, '..', '.claude.json')
    const servers = readLegacyMcpServers(
      makeFs({
        [legacyGlobal]: JSON.stringify({
          mcpServers: { a: { command: 'x' }, b: { command: 'y' } },
        }),
      }),
    )
    expect(Object.keys(servers ?? {}).sort()).toEqual(['a', 'b'])
  })

  test('tolerates a malformed legacy config rather than throwing', () => {
    const legacyGlobal = join(CLAUDE_DIR, '..', '.claude.json')
    expect(readLegacyMcpServers(makeFs({ [legacyGlobal]: '{not json' }))).toBe(
      null,
    )
  })

  test('ignores a non-object mcpServers value', () => {
    const legacyGlobal = join(CLAUDE_DIR, '..', '.claude.json')
    expect(
      readLegacyMcpServers(
        makeFs({ [legacyGlobal]: JSON.stringify({ mcpServers: [1, 2] }) }),
      ),
    ).toBe(null)
  })
})

describe('isMigrationSuppressed', () => {
  test('is false by default', () => {
    expect(isMigrationSuppressed()).toBe(false)
  })

  test('honours OCC_SKIP_MIGRATION for non-interactive environments', () => {
    process.env[SKIP] = '1'
    expect(isMigrationSuppressed()).toBe(true)
  })
})

describe('describeMigrationPlan', () => {
  test('states plainly that credentials are not copied by default', () => {
    const plan = planMigrationFromClaude(
      makeFs({}, [CLAUDE_DIR, join(CLAUDE_DIR, 'skills')]),
    )
    const text = describeMigrationPlan(plan)
    expect(text).toContain('skills')
    expect(text).toContain('NOT copy credentials')
    expect(text).toContain('left untouched')
  })

  test('modeDetails:false leaves the credential decision out entirely', () => {
    // What the wizard renders above the three options: saying anything about
    // credentials there would contradict whichever option the user picks.
    const plan = planMigrationFromClaude(
      makeFs({}, [CLAUDE_DIR, join(CLAUDE_DIR, 'skills')]),
    )
    const text = describeMigrationPlan(plan, { modeDetails: false })
    expect(text).toContain('skills')
    expect(text).toContain('left untouched')
    expect(text).not.toContain('credentials')
  })

  test('warns about the shared refresh token when credentials are included', () => {
    const plan = planMigrationFromClaude(
      makeFs({}, [CLAUDE_DIR, join(CLAUDE_DIR, 'skills')]),
      { migrateCredentials: true },
    )
    const text = describeMigrationPlan(plan)
    expect(text).toContain('your login (OAuth token / API key)')
    expect(text).toContain('Will copy credentials')
    expect(text).not.toContain('NOT copy credentials')
    expect(text).toContain('refreshes first')
  })
})

describe('planMigrationFromClaude with force', () => {
  test('force ignores the marker but still refuses to clobber', () => {
    process.env[OCC] = '/tmp/occ-forced'
    occConfigDir.cache.clear?.()
    const plan = planMigrationFromClaude(
      makeFs({ [join('/tmp/occ-forced', MIGRATION_MARKER)]: '' }, [
        CLAUDE_DIR,
        join(CLAUDE_DIR, 'skills'),
        join(CLAUDE_DIR, 'agents'),
        // agents already migrated — must not be re-copied even with --force
        join('/tmp/occ-forced', 'agents'),
      ]),
      { force: true },
    )
    expect(plan.alreadyMigrated).toBe(true)
    expect(plan.forced).toBe(true)
    expect(plan.items.map(i => i.name)).toEqual(['skills'])
    // A forced run reports the item list rather than "already migrated".
    expect(describeMigrationPlan(plan)).toContain('Would copy')
  })
})

// The two modes differ only in whether SECRETS ride along. Everything the user
// authored or installed — plugins, skills, MCP definitions, settings — comes
// across either way.
describe('planMigrationFromClaude — modes', () => {
  const OCC_DIR = join(homedir(), '.occ-mode-test')

  function legacySetup(): FsProbe {
    const files: Record<string, string> = {
      [join(CLAUDE_DIR, 'settings.json')]: JSON.stringify({
        theme: 'dark',
        env: {
          ANTHROPIC_API_KEY: 'sk-secret',
          ANTHROPIC_BASE_URL: 'https://proxy.example.com',
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000',
        },
        apiKeyHelper: '/bin/get-key',
        enabledPlugins: { 'formatter@some-market': true },
      }),
      [join(CLAUDE_DIR, 'CLAUDE.md')]: '# memory',
      [join(homedir(), '.claude.json')]: JSON.stringify({
        mcpServers: {
          internal: { command: 'x', env: { TOKEN: 'secret' } },
          other: { command: 'y' },
        },
        env: {
          OPENAI_API_KEY: 'sk-openai',
          OPENAI_BASE_URL: 'https://oai.example.com',
        },
      }),
    }
    const dirs = [
      CLAUDE_DIR,
      ...MIGRATED_DIRECTORIES.map(d => join(CLAUDE_DIR, d)),
    ]
    return makeFs(files, dirs)
  }

  beforeEach(() => {
    process.env[OCC] = OCC_DIR
    occConfigDir.cache.clear?.()
  })

  test('no-credentials mode still migrates plugins, skills and MCP servers', () => {
    const plan = planMigrationFromClaude(legacySetup())
    const names = plan.items.map(i => i.name)

    expect(plan.migrateCredentials).toBe(false)
    for (const kept of [
      'plugins',
      'skills',
      'agents',
      'commands',
      'workflows',
      'rules',
    ]) {
      expect(names).toContain(kept)
    }
    expect(names).toContain('settings.json')
    expect(names).toContain('CLAUDE.md')
    expect(plan.mcpServerCount).toBe(2)
  })

  test('no-credentials mode names every secret it will strip', () => {
    const plan = planMigrationFromClaude(legacySetup())
    expect(plan.strippedItems.some(s => s.includes('apiKeyHelper'))).toBe(true)
    expect(plan.strippedItems.some(s => s.includes('ANTHROPIC_API_KEY'))).toBe(
      true,
    )
    expect(
      plan.strippedItems.some(
        s => s.includes('MCP internal') && s.includes('TOKEN'),
      ),
    ).toBe(true)
    expect(plan.strippedItems.some(s => s.includes('OPENAI_API_KEY'))).toBe(
      true,
    )
    // Routing config is not stripped and must not be advertised as such.
    expect(plan.strippedItems.some(s => s.includes('ANTHROPIC_BASE_URL'))).toBe(
      false,
    )
    expect(plan.strippedItems.some(s => s.includes('OPENAI_BASE_URL'))).toBe(
      false,
    )

    const summary = describeMigrationPlan(plan)
    expect(summary).toContain('Stripped as credentials')
    expect(summary).toContain('apiKeyHelper')
  })

  test('does not promise to strip a settings.json it is not copying', () => {
    // occ already has one, so it is skipped by the no-clobber rule — claiming
    // a key would be stripped out of a file nobody touches is a lie.
    const fs = legacySetup()
    const withOccSettings: FsProbe = {
      ...fs,
      exists: p => p === join(OCC_DIR, 'settings.json') || fs.exists(p),
    }
    const plan = planMigrationFromClaude(withOccSettings)
    expect(plan.items.map(i => i.name)).not.toContain('settings.json')
    expect(plan.strippedItems.some(s => s.startsWith('settings.json'))).toBe(
      false,
    )
    // The MCP and global-config strips still apply.
    expect(plan.strippedItems.some(s => s.includes('MCP internal'))).toBe(true)
  })

  test('names plugin config it copies verbatim because it cannot classify it', () => {
    // pluginConfigs values are plugin-authored and free-form. The sensitive
    // half is supposed to live in secure storage, but that split is enforced by
    // each plugin's own manifest — so the residue is reported rather than
    // silently trusted, and rather than deleted (which would take out every
    // plugin's working non-secret config).
    const fs = makeFs(
      {
        [join(CLAUDE_DIR, 'settings.json')]: JSON.stringify({
          theme: 'dark',
          pluginConfigs: { 'notifier@market': { options: { channel: 'ops' } } },
        }),
      },
      [CLAUDE_DIR],
    )
    const plan = planMigrationFromClaude(fs)
    expect(plan.unclassifiedItems).toHaveLength(1)
    expect(plan.unclassifiedItems[0]).toContain('notifier@market')
    expect(describeMigrationPlan(plan)).toContain('Copied as-is')
  })

  test('says nothing about plugin config when there is none', () => {
    expect(planMigrationFromClaude(legacySetup()).unclassifiedItems).toEqual([])
  })

  test('full mode strips nothing and plans the credential copy', () => {
    const plan = planMigrationFromClaude(legacySetup(), {
      migrateCredentials: true,
    })
    expect(plan.migrateCredentials).toBe(true)
    expect(plan.strippedItems).toEqual([])
    expect(plan.mcpServerCount).toBe(2)
    expect(describeMigrationPlan(plan)).toContain('your login')
  })

  test('the deprecated --skip-account-data alias forces the credential-free mode', () => {
    const plan = planMigrationFromClaude(legacySetup(), {
      migrateCredentials: true,
      skipAccountData: true,
    })
    expect(plan.migrateCredentials).toBe(false)
  })
})

describe('readMigrationMarker', () => {
  const OCC_DIR = '/tmp/occ-marker-test'
  const markerPath = join(OCC_DIR, MIGRATION_MARKER)

  beforeEach(() => {
    process.env[OCC] = OCC_DIR
    occConfigDir.cache.clear?.()
  })

  test('returns null when no migration has run', () => {
    expect(readMigrationMarker(makeFs({}))).toBe(null)
  })

  test('reads the recorded categories', () => {
    const marker = readMigrationMarker(
      makeFs({
        [markerPath]: JSON.stringify({
          migratedAt: '2026-08-04T00:00:00.000Z',
          sourceDir: CLAUDE_DIR,
          credentials: true,
        }),
      }),
    )
    expect(marker).toEqual({
      migratedAt: '2026-08-04T00:00:00.000Z',
      sourceDir: CLAUDE_DIR,
      credentials: true,
    })
  })

  test('treats the pre-2.9 plain-text marker as credential-free', () => {
    const marker = readMigrationMarker(
      makeFs({ [markerPath]: `migrated from ${CLAUDE_DIR}\n` }),
    )
    expect(marker).toEqual({ credentials: false })
  })
})

// "I picked option 2, then changed my mind" has to work without --force, or
// the marker would make the only route a full re-walk of the tree.
describe('credential top-up after a credential-free migration', () => {
  const OCC_DIR = '/tmp/occ-topup-test'
  const markerPath = join(OCC_DIR, MIGRATION_MARKER)

  function migratedFs(credentials: boolean): FsProbe {
    return makeFs(
      {
        [markerPath]: JSON.stringify({ credentials }),
      },
      [CLAUDE_DIR, join(CLAUDE_DIR, 'skills')],
    )
  }

  beforeEach(() => {
    process.env[OCC] = OCC_DIR
    occConfigDir.cache.clear?.()
  })

  test('--with-credentials tops up without re-copying files', () => {
    const plan = planMigrationFromClaude(migratedFs(false), {
      migrateCredentials: true,
    })
    expect(plan.alreadyMigrated).toBe(true)
    expect(plan.credentialsOnly).toBe(true)
    expect(plan.items).toEqual([])
    expect(plan.mcpServerCount).toBe(0)
    expect(planHasWork(plan)).toBe(true)
    expect(describeMigrationPlan(plan)).toContain('without credentials')
  })

  test('a second --with-credentials run is a no-op', () => {
    const plan = planMigrationFromClaude(migratedFs(true), {
      migrateCredentials: true,
    })
    expect(plan.credentialsOnly).toBe(false)
    expect(planHasWork(plan)).toBe(false)
    expect(describeMigrationPlan(plan)).toContain('Already migrated')
  })

  test('a plain re-run stays short-circuited', () => {
    const plan = planMigrationFromClaude(migratedFs(false))
    expect(plan.credentialsOnly).toBe(false)
    expect(planHasWork(plan)).toBe(false)
  })
})

// The half the top-up used to miss. `--with-credentials` promises the API keys
// in settings.env, but on a second run the per-item no-clobber check skips the
// settings.json a credential-free run already wrote — secrets and all.
describe('settings.json secret top-up', () => {
  const OCC_DIR = '/tmp/occ-settings-topup-test'

  const LEGACY_SETTINGS = JSON.stringify({
    theme: 'dark',
    apiKeyHelper: '/bin/get-key',
    env: {
      ANTHROPIC_API_KEY: 'sk-secret',
      ANTHROPIC_BASE_URL: 'https://proxy.example.com',
    },
  })
  // What a credential-free run left behind: routing kept, secrets gone.
  const STRIPPED_SETTINGS = JSON.stringify({
    theme: 'dark',
    env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' },
  })

  function fsWith(marker: string | null): FsProbe {
    const files: Record<string, string> = {
      [join(CLAUDE_DIR, 'settings.json')]: LEGACY_SETTINGS,
      [join(OCC_DIR, 'settings.json')]: STRIPPED_SETTINGS,
    }
    if (marker !== null) files[join(OCC_DIR, MIGRATION_MARKER)] = marker
    return makeFs(files, [CLAUDE_DIR])
  }

  beforeEach(() => {
    process.env[OCC] = OCC_DIR
    occConfigDir.cache.clear?.()
  })

  test('the credentials-only top-up plans to restore what was stripped', () => {
    const plan = planMigrationFromClaude(
      fsWith(JSON.stringify({ credentials: false })),
      { migrateCredentials: true },
    )
    expect(plan.credentialsOnly).toBe(true)
    expect(plan.settingsSecretTopUp.sort()).toEqual([
      'apiKeyHelper',
      'env.ANTHROPIC_API_KEY',
    ])
    expect(planHasWork(plan)).toBe(true)

    // And says so, instead of pointing at a --force that cannot deliver it.
    const summary = describeMigrationPlan(plan)
    expect(summary).toContain('apiKeyHelper')
    expect(summary).toContain('env.ANTHROPIC_API_KEY')
    expect(summary).not.toContain('--force')
    expect(summary).toContain('does not overwrite')
  })

  test('--force --with-credentials plans the same restore', () => {
    const plan = planMigrationFromClaude(
      fsWith(JSON.stringify({ credentials: false })),
      { migrateCredentials: true, force: true },
    )
    // no-clobber still skips the file itself...
    expect(plan.items.map(i => i.name)).not.toContain('settings.json')
    // ...so the restore is the only thing that can deliver the secrets.
    expect(plan.settingsSecretTopUp.sort()).toEqual([
      'apiKeyHelper',
      'env.ANTHROPIC_API_KEY',
    ])
  })

  test('the credential-free mode never plans a restore', () => {
    const plan = planMigrationFromClaude(
      fsWith(JSON.stringify({ credentials: false })),
    )
    expect(plan.settingsSecretTopUp).toEqual([])
  })

  test('a fresh run copies the file whole, so there is nothing to restore', () => {
    const fresh = makeFs(
      { [join(CLAUDE_DIR, 'settings.json')]: LEGACY_SETTINGS },
      [CLAUDE_DIR],
    )
    const plan = planMigrationFromClaude(fresh, { migrateCredentials: true })
    expect(plan.items.map(i => i.name)).toContain('settings.json')
    expect(plan.settingsSecretTopUp).toEqual([])
  })
})

describe('restoreStrippedSettings', () => {
  test('puts back only what the strip rules remove', () => {
    const { settings, restored } = restoreStrippedSettings(
      {
        theme: 'light',
        apiKeyHelper: '/bin/get-key',
        statusLine: 'legacy-status',
        env: {
          ANTHROPIC_API_KEY: 'sk-secret',
          ANTHROPIC_BASE_URL: 'https://legacy',
        },
      },
      { theme: 'dark', env: { ANTHROPIC_BASE_URL: 'https://occ-own' } },
    )

    expect(restored.sort()).toEqual(['apiKeyHelper', 'env.ANTHROPIC_API_KEY'])
    expect(settings.apiKeyHelper).toBe('/bin/get-key')
    expect((settings.env as Record<string, string>).ANTHROPIC_API_KEY).toBe(
      'sk-secret',
    )
    // A non-secret the user deleted on the occ side stays deleted — this is a
    // credential top-up, not a re-sync.
    expect(settings.statusLine).toBeUndefined()
    // And nothing already set is touched.
    expect(settings.theme).toBe('dark')
    expect((settings.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe(
      'https://occ-own',
    )
  })

  test('never overwrites a secret the user already set on the occ side', () => {
    const { settings, restored } = restoreStrippedSettings(
      { apiKeyHelper: '/bin/legacy', env: { ANTHROPIC_API_KEY: 'sk-legacy' } },
      { apiKeyHelper: '/bin/occ', env: { ANTHROPIC_API_KEY: 'sk-occ' } },
    )
    expect(restored).toEqual([])
    expect(settings.apiKeyHelper).toBe('/bin/occ')
    expect((settings.env as Record<string, string>).ANTHROPIC_API_KEY).toBe(
      'sk-occ',
    )
  })

  test('nothing to restore is reported as an empty list', () => {
    expect(restoreStrippedSettings({ theme: 'dark' }, {}).restored).toEqual([])
  })
})

describe('isCredentialEnvKey', () => {
  test('classifies secrets as secrets', () => {
    for (const key of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GROK_API_KEY',
      'XAI_API_KEY',
      'GEMINI_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SESSION_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK',
      'ANTHROPIC_CUSTOM_HEADERS',
      'OTEL_EXPORTER_OTLP_HEADERS',
      // The one genuine secret in the mTLS trio: the cert and key are paths,
      // this is the passphrase that unlocks the key.
      'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
      'SOME_FUTURE_PROVIDER_API_KEY',
    ]) {
      expect([key, isCredentialEnvKey(key)]).toEqual([key, true])
    }
  })

  test('keeps routing and behaviour config', () => {
    for (const key of [
      'ANTHROPIC_BASE_URL',
      'OPENAI_BASE_URL',
      'GEMINI_BASE_URL',
      'ANTHROPIC_MODEL',
      'OPENAI_DEFAULT_SONNET_MODEL',
      'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'CLAUDE_CODE_1M_CONTEXT_MODELS',
      'MAX_THINKING_TOKENS',
      // Contains "API_KEY" but is a timeout, not a key — the reason this is
      // suffix-matched instead of substring-matched.
      'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
      'CLAUDE_CODE_USE_OPENAI',
      'OPENAI_AUTH_MODE',
      'AWS_REGION',
      'AWS_PROFILE',
    ]) {
      expect([key, isCredentialEnvKey(key)]).toEqual([key, false])
    }
  })

  // Adversarial: names that LOOK like secrets to a suffix rule but are not.
  // Getting any of these wrong is silent — the migration succeeds and the
  // feature breaks later, somewhere else.
  test('keeps the mTLS pair together — both halves are file paths', () => {
    // The suffix rule used to split this pair: `_KEY` matched,
    // `_CERT` did not. A migrated setup kept the certificate, lost the key
    // and failed every TLS handshake. Both are paths (mtls.ts:30-59).
    expect(isCredentialEnvKey('CLAUDE_CODE_CLIENT_CERT')).toBe(false)
    expect(isCredentialEnvKey('CLAUDE_CODE_CLIENT_KEY')).toBe(false)
    // ...but the passphrase for that key is a secret.
    expect(isCredentialEnvKey('CLAUDE_CODE_CLIENT_KEY_PASSPHRASE')).toBe(true)
  })

  test('keeps OTel client cert/key paths', () => {
    // Same shape as the mTLS pair: the OTel spec defines both as file paths.
    expect(
      isCredentialEnvKey('OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE'),
    ).toBe(false)
    expect(isCredentialEnvKey('OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY')).toBe(
      false,
    )
  })

  test('keeps OPENAI_PROMPT_CACHE_KEY — a 1/0 toggle, not a key', () => {
    // openaiShared.ts reads it as a boolean override for whether to send
    // `prompt_cache_key`; it is also one of the PROFILE_ENV_KEYS a provider
    // profile manages, so stripping it silently changed request shape.
    expect(isCredentialEnvKey('OPENAI_PROMPT_CACHE_KEY')).toBe(false)
  })

  test('exemptions are exact, not prefix or substring matches', () => {
    // A future `CLAUDE_CODE_CLIENT_KEY_B64` (inline material) must not inherit
    // the path exemption.
    expect(isCredentialEnvKey('MY_CLAUDE_CODE_CLIENT_KEY')).toBe(true)
    expect(isCredentialEnvKey('OPENAI_PROMPT_CACHE_KEY_SECRET')).toBe(true)
  })
})

describe('stripCredentialsFromSettings', () => {
  test('keeps endpoints and drops keys', () => {
    const { settings, droppedKeys, droppedEnvKeys } =
      stripCredentialsFromSettings({
        theme: 'dark',
        apiKeyHelper: '/bin/get-key',
        awsAuthRefresh: 'aws sso login',
        forceLoginMethod: 'claudeai',
        enabledPlugins: { 'formatter@market': true },
        env: {
          ANTHROPIC_API_KEY: 'sk-secret',
          ANTHROPIC_BASE_URL: 'https://proxy.example.com',
          ANTHROPIC_MODEL: 'claude-sonnet-4-6',
          CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000',
        },
      })

    expect(settings.theme).toBe('dark')
    // Not secrets: a login-method preference and the plugin install list, whose
    // plugins/ directory migrates in this mode too.
    expect(settings.forceLoginMethod).toBe('claudeai')
    expect(settings.enabledPlugins).toEqual({ 'formatter@market': true })
    expect(settings.apiKeyHelper).toBeUndefined()
    expect(settings.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://proxy.example.com',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000',
    })
    expect(droppedKeys.sort()).toEqual(['apiKeyHelper', 'awsAuthRefresh'])
    expect(droppedEnvKeys).toEqual(['ANTHROPIC_API_KEY'])
  })

  test('omits env entirely when nothing survives', () => {
    const { settings, droppedEnvKeys } = stripCredentialsFromSettings({
      env: { ANTHROPIC_API_KEY: 'sk-secret' },
    })
    expect('env' in settings).toBe(false)
    expect(droppedEnvKeys).toEqual(['ANTHROPIC_API_KEY'])
  })

  test('leaves a non-object env alone rather than crashing', () => {
    const { settings } = stripCredentialsFromSettings({ env: null })
    expect(settings.env).toBe(null)
  })
})

describe('stripCredentialsFromMcpServers', () => {
  test('keeps the definition and removes env/headers', () => {
    const { servers, stripped } = stripCredentialsFromMcpServers({
      internal: {
        command: 'node',
        args: ['server.js'],
        env: { TOKEN: 'secret', REGION: 'eu' },
      },
      remote: {
        type: 'http',
        url: 'https://x',
        headers: { Authorization: 'Bearer y' },
      },
      plain: { command: 'y' },
    })

    expect(servers.internal).toEqual({ command: 'node', args: ['server.js'] })
    expect(servers.remote).toEqual({ type: 'http', url: 'https://x' })
    expect(servers.plain).toEqual({ command: 'y' })

    expect(stripped).toHaveLength(2)
    expect(stripped[0]).toContain('MCP internal')
    expect(stripped[0]).toContain('TOKEN, REGION')
    expect(stripped[0]).toContain('re-add before use')
    expect(stripped[1]).toContain('headers Authorization')
  })
})

describe('buildGlobalConfigMerge', () => {
  const legacy = {
    mcpServers: {
      internal: { command: 'x', env: { TOKEN: 'secret' } },
    },
    env: {
      ANTHROPIC_BASE_URL: 'https://proxy',
      ANTHROPIC_API_KEY: 'sk-secret',
    },
    primaryApiKey: 'sk-primary',
    oauthAccount: { accountUuid: 'abc' },
    customApiKeyResponses: { approved: ['abcd'] },
    workspaceApiKey: 'sk-ant-api03-workspace',
    unrelated: 'ignored',
  }

  test('full mode carries account keys and unstripped MCP env across', () => {
    const merge = buildGlobalConfigMerge(legacy, {
      migrateCredentials: true,
      includeMcpServers: true,
    })
    const merged = merge.apply({})

    expect(merge.changed).toBe(true)
    expect(merge.mcpServersImported).toBe(1)
    expect(
      (merged.mcpServers as Record<string, { env?: unknown }>).internal.env,
    ).toEqual({ TOKEN: 'secret' })
    expect(merged.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://proxy',
      ANTHROPIC_API_KEY: 'sk-secret',
    })
    expect(merged.primaryApiKey).toBe('sk-primary')
    expect(merged.oauthAccount).toEqual({ accountUuid: 'abc' })
    expect(merged.customApiKeyResponses).toEqual({ approved: ['abcd'] })
    expect(merged.workspaceApiKey).toBe('sk-ant-api03-workspace')
    // Only the named account keys come across, not the whole legacy file.
    expect(merged.unrelated).toBeUndefined()
  })

  test('no-credentials mode keeps the endpoint and drops every secret', () => {
    const merge = buildGlobalConfigMerge(legacy, {
      migrateCredentials: false,
      includeMcpServers: true,
    })
    const merged = merge.apply({})

    expect((merged.mcpServers as Record<string, unknown>).internal).toEqual({
      command: 'x',
    })
    expect(merged.env).toEqual({ ANTHROPIC_BASE_URL: 'https://proxy' })
    expect(merged.primaryApiKey).toBeUndefined()
    expect(merged.oauthAccount).toBeUndefined()
    expect(merged.workspaceApiKey).toBeUndefined()
    expect(merge.notes.some(n => n.includes('ANTHROPIC_API_KEY'))).toBe(true)
    expect(merge.notes.some(n => n.includes('MCP internal'))).toBe(true)
  })

  test('never clobbers values occ already has', () => {
    const merge = buildGlobalConfigMerge(legacy, {
      migrateCredentials: true,
      includeMcpServers: true,
    })
    const merged = merge.apply({
      primaryApiKey: 'sk-occ-own',
      oauthAccount: { accountUuid: 'occ' },
      mcpServers: { internal: { command: 'occ-owned' } },
      env: { ANTHROPIC_BASE_URL: 'https://occ-own' },
    })

    expect(merged.primaryApiKey).toBe('sk-occ-own')
    expect(merged.oauthAccount).toEqual({ accountUuid: 'occ' })
    expect(
      (merged.mcpServers as Record<string, { command: string }>).internal
        .command,
    ).toBe('occ-owned')
    expect((merged.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe(
      'https://occ-own',
    )
  })

  // "would write" and "did write" are different answers under no-clobber, and
  // only the second one may be reported to the user or recorded in the marker.
  test('accountKeysWritten reports what apply() actually wrote', () => {
    const merge = buildGlobalConfigMerge(legacy, {
      migrateCredentials: true,
      includeMcpServers: true,
    })
    // Before apply(), nothing has been written.
    expect(merge.accountKeysWritten).toEqual([])

    merge.apply({ primaryApiKey: 'sk-occ-own' })
    expect(merge.accountKeysWritten).not.toContain('primaryApiKey')
    expect(merge.accountKeysWritten.sort()).toEqual([
      'customApiKeyResponses',
      'oauthAccount',
      'workspaceApiKey',
    ])
  })

  test('accountKeysWritten is empty when occ already holds every key', () => {
    const merge = buildGlobalConfigMerge(legacy, {
      migrateCredentials: true,
      includeMcpServers: true,
    })
    merge.apply({
      primaryApiKey: 'a',
      oauthAccount: 'b',
      customApiKeyResponses: 'c',
      workspaceApiKey: 'd',
    })
    expect(merge.accountKeysWritten).toEqual([])
  })

  test('a re-applied merge does not accumulate stale write records', () => {
    const merge = buildGlobalConfigMerge(legacy, {
      migrateCredentials: true,
      includeMcpServers: true,
    })
    merge.apply({})
    const first = [...merge.accountKeysWritten]
    merge.apply({})
    expect(merge.accountKeysWritten).toEqual(first)
  })

  test('the keychain key never displaces an explicit primaryApiKey', () => {
    const merge = buildGlobalConfigMerge(
      { primaryApiKey: 'sk-from-claude-json' },
      {
        migrateCredentials: true,
        includeMcpServers: true,
        apiKey: 'sk-from-keychain',
      },
    )
    expect(merge.apply({}).primaryApiKey).toBe('sk-from-claude-json')
  })

  test('a discovered legacy keychain key becomes primaryApiKey', () => {
    const merge = buildGlobalConfigMerge(
      {},
      {
        migrateCredentials: true,
        includeMcpServers: true,
        apiKey: 'sk-from-keychain',
      },
    )
    expect(merge.apply({}).primaryApiKey).toBe('sk-from-keychain')
  })

  test('a credentials-only top-up leaves MCP servers alone', () => {
    const merge = buildGlobalConfigMerge(legacy, {
      migrateCredentials: true,
      includeMcpServers: false,
    })
    const merged = merge.apply({})
    expect(merged.mcpServers).toBeUndefined()
    expect(merge.mcpServersImported).toBe(0)
    expect(merged.primaryApiKey).toBe('sk-primary')
  })

  test('nothing to merge is reported as no change', () => {
    const merge = buildGlobalConfigMerge(
      { unrelated: 1 },
      { migrateCredentials: false, includeMcpServers: true },
    )
    expect(merge.changed).toBe(false)
  })
})

// The inference that sits between two subsystems — secure storage and the
// ~/.occ.json merge — and was only wrong when one succeeded while the other
// failed. It used to take ANY imported account key as proof of a login.
describe('resolveCredentialOutcome', () => {
  test('an OAuth write is both migrated and available', () => {
    expect(
      resolveCredentialOutcome({
        oauthWritten: true,
        oauthAvailable: true,
        accountKeysWritten: [],
      }),
    ).toEqual({ credentialsMigrated: true, credentialsAvailable: true })
  })

  test('a pre-existing occ login is available but not migrated', () => {
    // no-clobber kept occ's own token: /login is pointless, but we did not
    // copy anything, so the shared-refresh-token warning must stay quiet.
    expect(
      resolveCredentialOutcome({
        oauthWritten: false,
        oauthAvailable: true,
        accountKeysWritten: [],
      }),
    ).toEqual({ credentialsMigrated: false, credentialsAvailable: true })
  })

  test('oauthAccount alone is NOT a login', () => {
    // The blocking regression. A locked keychain with no file fallback leaves
    // the credential step empty-handed, but the ~/.occ.json merge is not gated
    // on it and still imports oauthAccount — an identity record, not a
    // credential. Claiming a login here skipped the wizard's /login step and
    // dropped the user into an unauthenticated REPL.
    expect(
      resolveCredentialOutcome({
        oauthWritten: false,
        oauthAvailable: false,
        accountKeysWritten: ['oauthAccount'],
      }),
    ).toEqual({ credentialsMigrated: false, credentialsAvailable: false })
  })

  test('customApiKeyResponses alone is NOT a login', () => {
    // An approval ledger of truncated key hashes. Reachable on its own for an
    // env-var user whose ~/.claude.json holds nothing else.
    expect(
      resolveCredentialOutcome({
        oauthWritten: false,
        oauthAvailable: false,
        accountKeysWritten: ['customApiKeyResponses'],
      }),
    ).toEqual({ credentialsMigrated: false, credentialsAvailable: false })
  })

  test('both identity records together are still NOT a login', () => {
    expect(
      resolveCredentialOutcome({
        oauthWritten: false,
        oauthAvailable: false,
        accountKeysWritten: ['oauthAccount', 'customApiKeyResponses'],
      }),
    ).toEqual({ credentialsMigrated: false, credentialsAvailable: false })
  })

  test('primaryApiKey IS a login', () => {
    expect(
      resolveCredentialOutcome({
        oauthWritten: false,
        oauthAvailable: false,
        accountKeysWritten: ['primaryApiKey'],
      }),
    ).toEqual({ credentialsMigrated: true, credentialsAvailable: true })
  })

  test('workspaceApiKey IS a login', () => {
    expect(
      resolveCredentialOutcome({
        oauthWritten: false,
        oauthAvailable: false,
        accountKeysWritten: ['workspaceApiKey'],
      }),
    ).toEqual({ credentialsMigrated: true, credentialsAvailable: true })
  })

  test('an auth-bearing key mixed in with identity records still counts', () => {
    expect(
      resolveCredentialOutcome({
        oauthWritten: false,
        oauthAvailable: false,
        accountKeysWritten: ['oauthAccount', 'primaryApiKey'],
      }),
    ).toEqual({ credentialsMigrated: true, credentialsAvailable: true })
  })

  test('a run that wrote nothing claims nothing', () => {
    expect(
      resolveCredentialOutcome({
        oauthWritten: false,
        oauthAvailable: false,
        accountKeysWritten: [],
      }),
    ).toEqual({ credentialsMigrated: false, credentialsAvailable: false })
  })

  test('every auth-bearing key is one the merge can actually write', () => {
    // Guards a rename on either side: a key listed as auth-bearing but absent
    // from the merge list would silently never fire.
    for (const key of AUTH_BEARING_ACCOUNT_KEYS) {
      expect(LEGACY_ACCOUNT_CONFIG_KEYS as readonly string[]).toContain(key)
    }
    // ...and the identity records stay OUT of the auth-bearing list.
    for (const key of ['oauthAccount', 'customApiKeyResponses']) {
      expect(AUTH_BEARING_ACCOUNT_KEYS as readonly string[]).not.toContain(key)
    }
  })
})
