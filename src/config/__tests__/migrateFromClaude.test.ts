import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import {
  describeMigrationPlan,
  type FsProbe,
  isMigrationSuppressed,
  MIGRATED_DIRECTORIES,
  MIGRATED_FILES,
  MIGRATION_MARKER,
  NEVER_MIGRATED,
  planMigrationFromClaude,
  readLegacyMcpServers,
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

  test('never plans to copy credentials or session history', () => {
    // Populate the legacy dir with everything, including the forbidden paths.
    const dirs = [
      CLAUDE_DIR,
      ...MIGRATED_DIRECTORIES.map(d => join(CLAUDE_DIR, d)),
      ...NEVER_MIGRATED.map(d => join(CLAUDE_DIR, d)),
    ]
    const files: Record<string, string> = {}
    for (const f of MIGRATED_FILES) files[join(CLAUDE_DIR, f)] = 'x'
    for (const f of NEVER_MIGRATED) files[join(CLAUDE_DIR, f)] = 'secret'

    const plan = planMigrationFromClaude(makeFs(files, dirs))
    const planned = new Set(plan.items.map(i => i.name))
    for (const forbidden of NEVER_MIGRATED) {
      expect(planned.has(forbidden)).toBe(false)
    }
    // and specifically the credential file
    expect(planned.has('.credentials.json')).toBe(false)
    expect(planned.has('projects')).toBe(false)
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
  test('states plainly that credentials are not copied', () => {
    const plan = planMigrationFromClaude(
      makeFs({}, [CLAUDE_DIR, join(CLAUDE_DIR, 'skills')]),
    )
    const text = describeMigrationPlan(plan)
    expect(text).toContain('skills')
    expect(text).toContain('NOT copy credentials')
    expect(text).toContain('left untouched')
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
    expect(plan.items.map(i => i.name)).toEqual(['skills'])
  })
})

// `skipAccountData` is for someone moving onto a DIFFERENT account: credentials
// were never migrated, but plugins/skills/MCP servers and the auth-bearing
// settings keys still carry the old account's identity.
describe('planMigrationFromClaude — skipAccountData', () => {
  const OCC_DIR = join(homedir(), '.occ-skip-account-test')

  function legacySetup(): FsProbe {
    const files: Record<string, string> = {
      [join(CLAUDE_DIR, 'settings.json')]: JSON.stringify({
        theme: 'dark',
        env: { ANTHROPIC_API_KEY: 'sk-secret' },
        apiKeyHelper: '/bin/get-key',
        enabledPlugins: { 'formatter@some-market': true },
      }),
      [join(CLAUDE_DIR, 'CLAUDE.md')]: '# memory',
      [join(homedir(), '.claude.json')]: JSON.stringify({
        mcpServers: {
          internal: { command: 'x', env: { TOKEN: 'secret' } },
          other: { command: 'y' },
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

  test('excludes plugins, skills and MCP servers; keeps authored config', () => {
    const plan = planMigrationFromClaude(legacySetup(), {
      skipAccountData: true,
    })
    const names = plan.items.map(i => i.name)

    expect(names).not.toContain('plugins')
    expect(names).not.toContain('skills')
    expect(plan.mcpServerCount).toBe(0)

    // Everything the user authored still comes across.
    for (const kept of ['agents', 'commands', 'workflows', 'rules']) {
      expect(names).toContain(kept)
    }
    expect(names).toContain('settings.json')
    expect(names).toContain('CLAUDE.md')
  })

  test('reports what was excluded instead of dropping it silently', () => {
    const plan = planMigrationFromClaude(legacySetup(), {
      skipAccountData: true,
    })
    expect(plan.skipAccountData).toBe(true)
    expect(plan.excludedAccountItems).toContain('plugins/')
    expect(plan.excludedAccountItems).toContain('skills/')
    expect(
      plan.excludedAccountItems.some(s => s.includes('2 MCP servers')),
    ).toBe(true)
    expect(
      plan.excludedAccountItems.some(
        s => s.includes('env') && s.includes('apiKeyHelper'),
      ),
    ).toBe(true)

    const summary = describeMigrationPlan(plan)
    expect(summary).toContain('Excluded as account data')
    expect(summary).toContain('plugins/')
  })

  test('default (opt-in absent) still migrates everything', () => {
    const plan = planMigrationFromClaude(legacySetup())
    const names = plan.items.map(i => i.name)
    expect(names).toContain('plugins')
    expect(names).toContain('skills')
    expect(plan.mcpServerCount).toBe(2)
    expect(plan.skipAccountData).toBe(false)
    expect(plan.excludedAccountItems).toEqual([])
  })
})
