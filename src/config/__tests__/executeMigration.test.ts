/**
 * executeMigration's credential bookkeeping, end to end over a real temp tree.
 *
 * NO KEYCHAIN CONTACT, by construction: the credential step is injected, so
 * `security` is never spawned. It is injected rather than `mock.module`d
 * because Bun's registry is process-global — mocking migrateCredentials.ts here
 * would hand the mock to migrateCredentials.test.ts too.
 *
 * Every path comes from the plan (sourceDir/targetDir point at mkdtemp
 * directories), so nothing reads the developer's real ~/.claude either.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGlobalConfig } from '../../utils/config/config.js'
import type { CredentialMigrationOutcome } from '../migrateCredentials.js'
import {
  executeMigration,
  LEGACY_ACCOUNT_CONFIG_KEYS,
  MIGRATION_MARKER,
  type MigrationMarker,
  type MigrationPlan,
  planHasWork,
} from '../migrateFromClaude.js'

const sandboxes: string[] = []

beforeEach(() => {
  // Under NODE_ENV=test, saveGlobalConfig mutates one module-global object
  // instead of writing ~/.occ.json — so the account keys one test imports are
  // still there for the next, and no-clobber then refuses to write them again.
  // Clearing them is what makes these tests order-independent.
  const config = getGlobalConfig() as unknown as Record<string, unknown>
  for (const key of LEGACY_ACCOUNT_CONFIG_KEYS) delete config[key]
})

afterEach(() => {
  for (const dir of sandboxes.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The marker executeMigration wrote, read straight off disk. */
function readMarker(targetDir: string): MigrationMarker {
  return JSON.parse(
    readFileSync(join(targetDir, MIGRATION_MARKER), 'utf8'),
  ) as MigrationMarker
}

/** A legacy tree plus an empty occ tree, both under a fresh temp directory. */
function makeSandbox(legacyGlobal: Record<string, unknown>): {
  sourceDir: string
  targetDir: string
} {
  const root = mkdtempSync(join(tmpdir(), 'occ-exec-migration-'))
  sandboxes.push(root)
  const sourceDir = join(root, '.claude')
  const targetDir = join(root, '.occ')
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(targetDir, { recursive: true })
  // executeMigration derives the legacy global from plan.sourceDir/..
  writeFileSync(join(root, '.claude.json'), JSON.stringify(legacyGlobal))
  return { sourceDir, targetDir }
}

function makePlan(
  overrides: Partial<MigrationPlan> &
    Pick<MigrationPlan, 'sourceDir' | 'targetDir'>,
): MigrationPlan {
  return {
    sourceExists: true,
    alreadyMigrated: false,
    credentialsAlreadyMigrated: false,
    credentialsOnly: false,
    forced: false,
    items: [],
    mcpServerCount: 0,
    migrateCredentials: true,
    strippedItems: [],
    settingsSecretTopUp: [],
    unclassifiedItems: [],
    ...overrides,
  }
}

/** What migrateLegacyCredentials returns when the keychain is locked cold. */
function lockedKeychain(): CredentialMigrationOutcome {
  return {
    migrated: false,
    oauthAvailable: false,
    apiKey: null,
    notes: [],
    errors: ['credentials: the macOS login keychain is locked, …'],
  }
}

function foundOAuth(): CredentialMigrationOutcome {
  return {
    migrated: true,
    oauthAvailable: true,
    apiKey: null,
    notes: ['OAuth login copied…'],
    errors: [],
  }
}

// The blocking regression this file exists for: a locked keychain leaves the
// credential step empty-handed, but the ~/.occ.json merge is not gated on it
// and still imports `oauthAccount`. That used to be taken as proof of a login.
describe('a locked keychain that still imported identity records', () => {
  const legacyGlobal = {
    oauthAccount: { accountUuid: 'abc', emailAddress: 'a@b.c' },
    customApiKeyResponses: { approved: ['abcd'] },
  }

  test('claims no login, so the wizard still shows /login', async () => {
    const { sourceDir, targetDir } = makeSandbox(legacyGlobal)
    const result = await executeMigration(makePlan({ sourceDir, targetDir }), {
      migrateCredentials: async () => lockedKeychain(),
    })

    // The identity records DID come across, and are reported as such…
    expect(result.notes.some(n => n.includes('oauthAccount'))).toBe(true)
    // …but they are not a credential.
    expect(result.credentialsAvailable).toBe(false)
    // …and the false "Both CLIs now share one login" warning stays off.
    expect(result.credentialsMigrated).toBe(false)
    expect(result.errors.some(e => e.includes('locked'))).toBe(true)
  })

  test('leaves the marker retryable, so the unlock-and-retry path works', async () => {
    const { sourceDir, targetDir } = makeSandbox(legacyGlobal)
    await executeMigration(makePlan({ sourceDir, targetDir }), {
      migrateCredentials: async () => lockedKeychain(),
    })

    expect(readMarker(targetDir).credentials).toBe(false)
  })

  test('the retry after unlocking is not short-circuited', async () => {
    const { sourceDir, targetDir } = makeSandbox(legacyGlobal)
    await executeMigration(makePlan({ sourceDir, targetDir }), {
      migrateCredentials: async () => lockedKeychain(),
    })

    // What `occ migrate --with-credentials` builds on the second run: the
    // marker exists but records credentials:false, so this is a top-up with
    // work to do rather than an "Already migrated" no-op.
    const retry = makePlan({
      sourceDir,
      targetDir,
      alreadyMigrated: true,
      credentialsAlreadyMigrated: false,
      credentialsOnly: true,
    })
    expect(planHasWork(retry)).toBe(true)

    const second = await executeMigration(retry, {
      migrateCredentials: async () => foundOAuth(),
    })
    expect(second.credentialsMigrated).toBe(true)
    expect(second.credentialsAvailable).toBe(true)
  })
})

describe('executeMigration credential bookkeeping', () => {
  test('an imported primaryApiKey does count as a login', async () => {
    const { sourceDir, targetDir } = makeSandbox({
      primaryApiKey: 'sk-primary',
      oauthAccount: { accountUuid: 'abc' },
    })
    const result = await executeMigration(makePlan({ sourceDir, targetDir }), {
      migrateCredentials: async () => lockedKeychain(),
    })
    expect(result.credentialsAvailable).toBe(true)
    expect(result.credentialsMigrated).toBe(true)
  })

  test('an imported workspaceApiKey does count as a login', async () => {
    const { sourceDir, targetDir } = makeSandbox({
      workspaceApiKey: 'sk-ant-api03-ws',
    })
    const result = await executeMigration(makePlan({ sourceDir, targetDir }), {
      migrateCredentials: async () => lockedKeychain(),
    })
    expect(result.credentialsAvailable).toBe(true)
  })

  test('the credential-free mode never claims a login', async () => {
    const { sourceDir, targetDir } = makeSandbox({
      primaryApiKey: 'sk-primary',
      oauthAccount: { accountUuid: 'abc' },
    })
    const result = await executeMigration(
      makePlan({ sourceDir, targetDir, migrateCredentials: false }),
      {
        migrateCredentials: async () => {
          throw new Error('credential step must not run in this mode')
        },
      },
    )
    expect(result.credentialsAvailable).toBe(false)
    expect(result.errors).toEqual([])
    // …and the account keys stayed behind entirely.
    expect(result.notes.some(n => n.includes('oauthAccount'))).toBe(false)
  })

  test('a run that copied a login records it, so the top-up stops being offered', async () => {
    const { sourceDir, targetDir } = makeSandbox({})
    await executeMigration(makePlan({ sourceDir, targetDir }), {
      migrateCredentials: async () => foundOAuth(),
    })
    expect(readMarker(targetDir).credentials).toBe(true)
  })

  test('a pre-existing occ login settles the marker without claiming a copy', async () => {
    const { sourceDir, targetDir } = makeSandbox({})
    const result = await executeMigration(makePlan({ sourceDir, targetDir }), {
      migrateCredentials: async () => ({
        migrated: false,
        oauthAvailable: true,
        apiKey: null,
        notes: ['open-claude-code already has a stored login…'],
        errors: [],
      }),
    })
    expect(result.credentialsMigrated).toBe(false)
    expect(result.credentialsAvailable).toBe(true)
  })

  test('reads the legacy global next to the plan’s source dir, not the real home', async () => {
    // Regression guard for the sandbox leak: executeMigration used to call
    // legacyClaudeConfigDir() directly, so a plan pointed at a temp tree still
    // read ~/.claude.json.
    const { sourceDir, targetDir } = makeSandbox({
      primaryApiKey: 'sk-sandbox',
    })
    const result = await executeMigration(makePlan({ sourceDir, targetDir }), {
      migrateCredentials: async () => lockedKeychain(),
    })
    expect(result.notes.some(n => n.includes('primaryApiKey'))).toBe(true)
  })
})
