/**
 * One-time migration of a user's setup from official Claude Code's `~/.claude`
 * into occ's `~/.occ`.
 *
 * DESIGN RULES — all four are load-bearing:
 *
 * 1. `~/.claude` is READ-ONLY. occ never writes to, moves, or deletes anything
 *    under it. The user may still be using the official CLI, and a migration
 *    that mutates the source is not a migration, it is a takeover.
 *
 * 2. Credentials are copied ONLY when the user explicitly asks, and never
 *    written back. `occ migrate` defaults to the credential-free mode; the
 *    OAuth token and API key come across only under `--with-credentials` (or
 *    the matching first-run choice). Even then the copy is one-way and
 *    no-clobber: occ's own storage wins if it already holds a login, and the
 *    official keychain entry is never modified. See migrateCredentials.ts.
 *
 * 3. Session history is NEVER copied. `projects/`, `history.jsonl` and the
 *    caches are large, machine-specific, and reference absolute paths; copying
 *    them buys nothing and can be tens of GB.
 *
 * 4. It is idempotent and never clobbers. A `.migrated` marker short-circuits
 *    subsequent runs, and any destination path that already exists is skipped
 *    rather than overwritten. The marker records WHICH categories ran, so a
 *    user who first migrated without credentials can top them up later with
 *    `occ migrate --with-credentials` instead of being locked out by the
 *    marker.
 *
 * THE TWO MODES
 *
 * Both copy the same things — settings, plugins, skills, agents, commands,
 * rules, memory and MCP server definitions. They differ only in whether SECRET
 * material rides along:
 *
 *   full            OAuth token, API key, `settings.env` and MCP `env`/`headers`
 *                   all come across. occ works immediately, no /login.
 *   no-credentials  Secrets in the places this file knows about are stripped,
 *                   but ROUTING survives: base URLs, model IDs, context-window
 *                   overrides and provider switches are kept, so the user
 *                   re-enters keys and nothing else. This is the default.
 *
 * The split is by key SHAPE, not by an allowlist — see isCredentialEnvKey().
 *
 * WHAT THE NO-CREDENTIALS MODE DOES NOT REACH
 *
 * Three places carry free-form, plugin-authored values that no rule here can
 * classify, so they are copied verbatim and CALLED OUT in the report instead of
 * being silently trusted or silently deleted:
 *
 *   - `settings.pluginConfigs[*].options` and `[*].mcpServers[*]`. By design
 *     these hold the NON-sensitive half only — anything a plugin manifest marks
 *     `sensitive: true` goes to secure storage, which this mode never touches
 *     (see pluginOptionsStorage.ts / mcpbHandler.ts). But that split is enforced
 *     by each plugin's own manifest, and it post-dates plugins that wrote bot
 *     tokens straight into settings.
 *   - Files inside `plugins/`, which are copied as a tree.
 *
 * Deleting them instead would take out the working, non-secret configuration of
 * every plugin to remove a secret that is usually not there — the same mistake
 * as the old "drop `env` wholesale" behaviour.
 */

import { join } from 'path'
// Type-only: the runtime import stays dynamic so the wizard and the
// pre-bootstrap `occ migrate` fast path never pay for the credential module.
import type { CredentialMigrationOutcome } from './migrateCredentials.js'
import {
  legacyClaudeConfigDir,
  occConfigDir,
  occGlobalConfigFile,
} from './paths.js'

/** Marker written into the occ config dir once a migration has run. */
export const MIGRATION_MARKER = '.migrated'

/**
 * Directories copied wholesale. These are things the user authored or
 * deliberately installed.
 */
export const MIGRATED_DIRECTORIES = [
  'skills',
  'agents',
  'commands',
  'output-styles',
  'workflows',
  'templates',
  'plugins',
  'rules',
] as const

/** Individual files copied. */
export const MIGRATED_FILES = [
  'settings.json',
  // User-level memory. Still named CLAUDE.md: the memory filename is an
  // ecosystem convention and is deliberately not renamed.
  'CLAUDE.md',
] as const

/**
 * `settings.json` keys that RESOLVE credentials — each one is a shell command
 * whose stdout is fed straight to a provider as an API key, an AWS/GCP
 * credential or an OTel auth header. Dropped in the no-credentials mode,
 * because keeping them would hand occ a live login through the back door,
 * which is precisely what the user just declined.
 *
 * Deliberately NOT dropped: `forceLoginMethod` (a preference, not a secret),
 * `enabledPlugins` and `extraKnownMarketplaces` (the plugins they point at are
 * migrated in both modes, so dropping these would strand the install).
 */
export const CREDENTIAL_SETTINGS_KEYS = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
] as const

/**
 * Suffixes that mark an environment variable as carrying secret material.
 *
 * Suffix matching rather than an allowlist, for two reasons. Providers keep
 * being added (`GROK_API_KEY` did not exist when this was written) and an
 * allowlist that lags a release leaks a key. And the near-misses are all
 * decided correctly by the suffix: `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` is a
 * timeout, `CLAUDE_CODE_MAX_CONTEXT_TOKENS` is a number, and neither ends in
 * `_KEY` or `_TOKEN` — note the singular, which is what keeps `..._TOKENS`
 * out.
 *
 * `_HEADERS` is here because `ANTHROPIC_CUSTOM_HEADERS` and the OTel exporter
 * headers carry a bearer token INLINE. Note what is deliberately absent:
 * `_CERT` / `_CERTIFICATE`. `CLAUDE_CODE_CLIENT_CERT` (mtls.ts:30) and OTel's
 * `*_CLIENT_CERTIFICATE` are FILE PATHS, and a path is not a secret.
 */
export const CREDENTIAL_ENV_SUFFIXES = [
  '_KEY',
  '_KEY_ID',
  '_APIKEY',
  '_TOKEN',
  '_SECRET',
  '_PASSWORD',
  '_PASSPHRASE',
  '_CREDENTIAL',
  '_CREDENTIALS',
  '_HEADERS',
] as const

/** Secrets whose names do not end in anything recognisable. */
const CREDENTIAL_ENV_EXACT = new Set(['AWS_BEARER_TOKEN_BEDROCK'])

/**
 * `_KEY`-shaped names that are NOT secret material, and must survive the
 * credential-free mode.
 *
 * The mTLS pair is the reason this list exists. `CLAUDE_CODE_CLIENT_CERT` and
 * `CLAUDE_CODE_CLIENT_KEY` are both paths to PEM files on disk (mtls.ts:30-59),
 * and the suffix rule split the pair down the middle: `_KEY` matched, `_CERT`
 * did not, so a migrated setup kept the certificate, lost the key, and every
 * TLS handshake failed. The secret in that trio is
 * `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`, which is stripped by `_PASSPHRASE`.
 *
 * `OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY` is the same shape (a path, per the
 * OTel spec). `OPENAI_PROMPT_CACHE_KEY` is not a key at all — it is a 1/0
 * toggle for whether to send `prompt_cache_key` (openaiShared.ts) and one of
 * the managed keys in PROFILE_ENV_KEYS.
 */
const NON_CREDENTIAL_ENV_EXACT = new Set([
  'CLAUDE_CODE_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY',
  'OPENAI_PROMPT_CACHE_KEY',
])

/**
 * Whether an env var holds a secret (stripped) rather than routing config
 * (kept: `*_BASE_URL`, `*_MODEL`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`,
 * `*_AUTH_MODE`, `CLAUDE_CODE_USE_*`, cert/key file paths, …).
 */
export function isCredentialEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  if (NON_CREDENTIAL_ENV_EXACT.has(upper)) return false
  if (CREDENTIAL_ENV_EXACT.has(upper)) return true
  return CREDENTIAL_ENV_SUFFIXES.some(suffix => upper.endsWith(suffix))
}

/**
 * Account-identity keys read out of the legacy `~/.claude.json`. Merged into
 * `~/.occ.json` only in the full mode, and only where occ has no value yet.
 */
export const LEGACY_ACCOUNT_CONFIG_KEYS = [
  'primaryApiKey',
  'oauthAccount',
  'customApiKeyResponses',
  'workspaceApiKey',
] as const

/**
 * The subset of LEGACY_ACCOUNT_CONFIG_KEYS that can actually AUTHENTICATE a
 * request. Only these may be taken as evidence that occ has a login.
 *
 * The other two look like credentials and are not. `oauthAccount` is an
 * identity record (account/org UUIDs, email) that the OAuth flow writes
 * alongside the token — copying it tells you who the user was, not that occ
 * can call the API. `customApiKeyResponses` holds truncated hashes of keys the
 * user approved or rejected; it is an approval ledger.
 *
 * Treating the whole list as proof of a login produced a reachable failure
 * chain: a locked keychain with no `.credentials.json` fallback makes the
 * credential step bail with nothing, but the ~/.occ.json merge is not gated on
 * it and still imports `oauthAccount` — which used to flip
 * `credentialsMigrated`, then `credentialsAvailable`, and the wizard skipped
 * /login straight into an unauthenticated REPL, showed a "Both CLIs now share
 * one login" warning that was false, and wrote `credentials: true` into the
 * marker so the unlock-and-retry path answered "Already migrated".
 */
export const AUTH_BEARING_ACCOUNT_KEYS = [
  'primaryApiKey',
  'workspaceApiKey',
] as const

export type CredentialOutcome = {
  /**
   * occ gained a usable credential it did not have before. Drives the
   * shared-refresh-token warning, so it must never fire for a copy that only
   * moved identity records.
   */
  credentialsMigrated: boolean
  /**
   * occ can authenticate now — this run's copy, or a login it already had.
   * Drives skipping the wizard's /login step and the `.migrated` marker, so a
   * false positive both strands the user and blocks the retry.
   */
  credentialsAvailable: boolean
}

/**
 * Decide what a migration run may claim about occ's login state.
 *
 * Pure and exported because this is the inference that got it wrong: it sits
 * between two subsystems (secure storage and the ~/.occ.json merge), and the
 * bug was only reachable when one of them succeeded while the other failed.
 */
export function resolveCredentialOutcome(input: {
  /** An OAuth blob was written into occ's secure storage by this run. */
  oauthWritten: boolean
  /** occ holds an OAuth login now, whether this run wrote it or not. */
  oauthAvailable: boolean
  /** Account keys the ~/.occ.json merge actually wrote (post no-clobber). */
  accountKeysWritten: readonly string[]
}): CredentialOutcome {
  const authBearingWritten = input.accountKeysWritten.some(key =>
    (AUTH_BEARING_ACCOUNT_KEYS as readonly string[]).includes(key),
  )
  return {
    credentialsMigrated: input.oauthWritten || authBearingWritten,
    credentialsAvailable: input.oauthAvailable || authBearingWritten,
  }
}

/**
 * Never copied, even if a future edit adds them to the lists above. Asserted in
 * tests so this stays true.
 *
 * `.credentials.json` stays on this list in BOTH modes: the full mode reads it
 * as a fallback source for the OAuth blob, but writes that blob into occ's own
 * secure storage rather than copying the file, so the two installs never end up
 * sharing a credential file.
 */
export const NEVER_MIGRATED = [
  '.credentials.json',
  'projects',
  'history.jsonl',
  'ide',
  'statsig',
  'logs',
  'shell-snapshots',
  'file-history',
  'todos',
] as const

export type MigrationItem = {
  name: string
  kind: 'dir' | 'file'
  from: string
  to: string
}

export type MigrationPlan = {
  sourceDir: string
  targetDir: string
  /** False when there is nothing to migrate from. */
  sourceExists: boolean
  /** True once a migration has already run (marker present). */
  alreadyMigrated: boolean
  /** True when a previous run already brought credentials across. */
  credentialsAlreadyMigrated: boolean
  /**
   * True when everything except credentials was migrated before and the user
   * is now topping the credentials up. Files and MCP servers stay untouched.
   */
  credentialsOnly: boolean
  /** `--force`: ignore the marker. Per-item no-clobber checks still apply. */
  forced: boolean
  /** Items that exist in the source and are absent from the destination. */
  items: MigrationItem[]
  /** Number of MCP servers found in the legacy global config file. */
  mcpServerCount: number
  /** True when the user asked for the OAuth token / API key to come across. */
  migrateCredentials: boolean
  /**
   * Secrets this plan will strip, named. Surfaced in the summary so no key
   * ever disappears silently and the user knows exactly what to re-enter.
   */
  strippedItems: string[]
  /**
   * Secrets an earlier credential-free run stripped out of `settings.json` that
   * this credential-carrying run will put back, named (`env.X` for env
   * entries).
   *
   * Without this, `--with-credentials` was a broken promise on any second run:
   * the per-item no-clobber check skips a `settings.json` that already exists,
   * even under `--force`, so the stripped `apiKeyHelper` and `env` keys could
   * only be recovered by deleting the file by hand.
   */
  settingsSecretTopUp: string[]
  /**
   * Free-form, plugin-authored config that is copied verbatim because no rule
   * here can classify it. Reported rather than trusted — see the file header.
   */
  unclassifiedItems: string[]
}

export type FsProbe = {
  exists: (path: string) => boolean
  isDirectory: (path: string) => boolean
  readFile: (path: string) => string
}

export type MigrationOptions = {
  force?: boolean
  /** Bring the OAuth token / API key across. Defaults to false. */
  migrateCredentials?: boolean
  /**
   * @deprecated Compatibility alias for the pre-2.9 flag. It used to exclude
   * plugins, skills and MCP servers wholesale; those now migrate in both modes
   * with their secrets stripped, so it maps onto the (default) credential-free
   * mode and is a no-op unless combined with `migrateCredentials`.
   */
  skipAccountData?: boolean
}

/**
 * Whether the migration should even be considered.
 *
 * `OCC_SKIP_MIGRATION=1` opts out permanently for scripted/CI environments,
 * where an interactive prompt would hang.
 */
export function isMigrationSuppressed(): boolean {
  const value = process.env.OCC_SKIP_MIGRATION
  return value === '1' || value === 'true'
}

export type MigrationMarker = {
  migratedAt?: string
  sourceDir?: string
  /** Whether that run included the credential half. */
  credentials: boolean
}

/**
 * Read the `.migrated` marker, tolerating the pre-2.9 plain-text form.
 *
 * The old marker was a one-line sentence, so anything that does not parse as
 * JSON is treated as "migrated, without credentials" — which is exactly what
 * those runs did.
 */
export function readMigrationMarker(fs: FsProbe): MigrationMarker | null {
  const path = join(occConfigDir(), MIGRATION_MARKER)
  if (!fs.exists(path)) return null
  try {
    const parsed = JSON.parse(fs.readFile(path)) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        migratedAt:
          typeof parsed.migratedAt === 'string' ? parsed.migratedAt : undefined,
        sourceDir:
          typeof parsed.sourceDir === 'string' ? parsed.sourceDir : undefined,
        credentials: parsed.credentials === true,
      }
    }
  } catch {
    // Legacy plain-text marker, or an unreadable one. Either way a migration
    // has run and it did not include credentials.
  }
  return { credentials: false }
}

/** Whether running this plan would actually do anything. */
export function planHasWork(plan: MigrationPlan): boolean {
  if (!plan.sourceExists) return false
  if (plan.items.length > 0 || plan.mcpServerCount > 0) return true
  if (plan.settingsSecretTopUp.length > 0) return true
  return (
    plan.migrateCredentials && (plan.forced || !plan.credentialsAlreadyMigrated)
  )
}

/**
 * Build a migration plan. Pure apart from the filesystem probes passed in,
 * which keeps it testable without touching a real home directory.
 *
 * Deliberately does NOT read the keychain: this runs while the first-run
 * wizard is assembling its steps, and a `security` spawn there would cost
 * every user a subprocess to answer a question the plan does not need. What
 * credentials actually exist is discovered at execute time.
 */
export function planMigrationFromClaude(
  fs: FsProbe,
  options: MigrationOptions = {},
): MigrationPlan {
  const sourceDir = legacyClaudeConfigDir()
  const targetDir = occConfigDir()
  // `skipAccountData` is the deprecated spelling of "no credentials", which is
  // already the default, so it only ever loses to an explicit opt-in.
  const migrateCredentials =
    options.migrateCredentials === true && options.skipAccountData !== true

  const marker = readMigrationMarker(fs)

  const plan: MigrationPlan = {
    sourceDir,
    targetDir,
    sourceExists: fs.exists(sourceDir) && fs.isDirectory(sourceDir),
    alreadyMigrated: marker !== null,
    credentialsAlreadyMigrated: marker?.credentials === true,
    credentialsOnly: false,
    forced: options.force === true,
    items: [],
    mcpServerCount: 0,
    migrateCredentials,
    strippedItems: [],
    settingsSecretTopUp: [],
    unclassifiedItems: [],
  }

  if (!plan.sourceExists) return plan

  // Guard against a same-directory migration: if the user pointed
  // OCC_CONFIG_DIR at ~/.claude there is nothing to do and copying a tree onto
  // itself would be destructive.
  if (sourceDir === targetDir) {
    plan.sourceExists = false
    return plan
  }

  // `force` ignores the marker but NOT the per-item no-clobber checks below,
  // so a forced run fills in what is missing rather than overwriting what the
  // user already has on the occ side.
  if (plan.alreadyMigrated && !options.force) {
    // Top-up: the file half is done, but the user has now asked for their
    // login. Run only that, rather than telling them "already migrated" and
    // making --force the only way — which would re-walk the whole tree.
    if (migrateCredentials && !plan.credentialsAlreadyMigrated) {
      plan.credentialsOnly = true
      plan.settingsSecretTopUp = planSettingsSecretTopUp(fs, plan)
    }
    return plan
  }

  for (const name of MIGRATED_DIRECTORIES) {
    const from = join(sourceDir, name)
    const to = join(targetDir, name)
    if (!fs.exists(from) || !fs.isDirectory(from) || fs.exists(to)) continue
    plan.items.push({ name, kind: 'dir', from, to })
  }

  for (const name of MIGRATED_FILES) {
    const from = join(sourceDir, name)
    const to = join(targetDir, name)
    if (fs.exists(from) && !fs.isDirectory(from) && !fs.exists(to)) {
      plan.items.push({ name, kind: 'file', from, to })
    }
  }

  const servers = readLegacyMcpServers(fs)
  plan.mcpServerCount = servers ? Object.keys(servers).length : 0

  if (migrateCredentials) {
    // A settings.json the no-clobber rule skipped may be one an earlier
    // credential-free run wrote — with the secrets taken out. Put them back.
    plan.settingsSecretTopUp = planSettingsSecretTopUp(fs, plan)
  } else {
    plan.strippedItems.push(...describeLegacyStrip(fs, plan, servers))
    plan.unclassifiedItems.push(...describeUnclassified(fs, plan))
  }

  return plan
}

/**
 * Secret keys an earlier credential-free run stripped out of `settings.json`
 * and that occ still does not have.
 *
 * Only runs when occ ALREADY has a settings.json — a fresh copy carries the
 * secrets itself. Restricted to the keys the strip rules remove, so a
 * credential top-up never resurrects a setting the user deliberately deleted.
 */
function planSettingsSecretTopUp(fs: FsProbe, plan: MigrationPlan): string[] {
  const legacyPath = join(plan.sourceDir, 'settings.json')
  const occPath = join(plan.targetDir, 'settings.json')
  if (!fs.exists(legacyPath) || !fs.exists(occPath)) return []
  try {
    const legacy = JSON.parse(fs.readFile(legacyPath)) as Record<
      string,
      unknown
    >
    const current = JSON.parse(fs.readFile(occPath)) as Record<string, unknown>
    return restoreStrippedSettings(legacy, current).restored
  } catch {
    // Either file unparseable — nothing safe to promise.
    return []
  }
}

/**
 * Free-form config that rides along verbatim in the credential-free mode
 * because no rule here can classify it. Named in the report so the residue is
 * the user's decision rather than our silent assumption. See the file header.
 */
function describeUnclassified(fs: FsProbe, plan: MigrationPlan): string[] {
  if (!plan.items.some(item => item.name === 'settings.json')) return []
  try {
    const parsed = JSON.parse(
      fs.readFile(join(plan.sourceDir, 'settings.json')),
    ) as Record<string, unknown>
    const configs = parsed.pluginConfigs
    if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
      return []
    }
    const names = Object.keys(configs as Record<string, unknown>)
    if (names.length === 0) return []
    return [
      `settings.json pluginConfigs (${names.join(', ')}): plugin-authored values copied as-is — check them if a plugin stored a token there`,
    ]
  } catch {
    return []
  }
}

/**
 * What the no-credentials mode would strip from this particular setup, named.
 * Computed at plan time so the confirmation screen can show it before anything
 * is written, and scoped to what this plan will actually copy — promising to
 * strip a key out of a settings.json that is being skipped as already-present
 * would be a lie.
 */
function describeLegacyStrip(
  fs: FsProbe,
  plan: MigrationPlan,
  servers: Record<string, unknown> | null,
): string[] {
  const lines: string[] = []

  if (plan.items.some(item => item.name === 'settings.json')) {
    try {
      const parsed = JSON.parse(
        fs.readFile(join(plan.sourceDir, 'settings.json')),
      ) as Record<string, unknown>
      const { droppedKeys, droppedEnvKeys } =
        stripCredentialsFromSettings(parsed)
      if (droppedKeys.length > 0) {
        lines.push(`settings.json: ${droppedKeys.join(', ')}`)
      }
      if (droppedEnvKeys.length > 0) {
        lines.push(`settings.json env: ${droppedEnvKeys.join(', ')}`)
      }
    } catch {
      // Unparseable legacy settings — nothing to promise about.
    }
  }

  if (servers) {
    lines.push(...stripCredentialsFromMcpServers(servers).stripped)
  }

  const legacyEnv = readLegacyGlobalConfig(fs)?.env
  if (legacyEnv && typeof legacyEnv === 'object' && !Array.isArray(legacyEnv)) {
    const dropped = Object.keys(legacyEnv).filter(isCredentialEnvKey)
    if (dropped.length > 0) {
      lines.push(`~/.claude.json env: ${dropped.join(', ')}`)
    }
  }

  return lines
}

export type SettingsStripResult = {
  settings: Record<string, unknown>
  /** Top-level keys removed. */
  droppedKeys: string[]
  /** `env` entries removed, by name. */
  droppedEnvKeys: string[]
}

/**
 * Strip secrets out of a legacy `settings.json` while keeping everything else,
 * including the routing half of `env`.
 *
 * The old implementation dropped `env` wholesale. That threw away the base
 * URLs, model IDs and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` of every third-party
 * provider setup — the config that is tedious to reconstruct — to remove the
 * one key the user can paste back in ten seconds.
 */
export function stripCredentialsFromSettings(
  parsed: Record<string, unknown>,
): SettingsStripResult {
  const settings: Record<string, unknown> = {}
  const droppedKeys: string[] = []
  const droppedEnvKeys: string[] = []

  for (const [key, value] of Object.entries(parsed)) {
    if ((CREDENTIAL_SETTINGS_KEYS as readonly string[]).includes(key)) {
      droppedKeys.push(key)
      continue
    }
    if (
      key === 'env' &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const keptEnv: Record<string, unknown> = {}
      for (const [envKey, envValue] of Object.entries(
        value as Record<string, unknown>,
      )) {
        if (isCredentialEnvKey(envKey)) {
          droppedEnvKeys.push(envKey)
          continue
        }
        keptEnv[envKey] = envValue
      }
      // An empty `env` is noise; omit it rather than writing `{}`.
      if (Object.keys(keptEnv).length > 0) settings.env = keptEnv
      continue
    }
    settings[key] = value
  }

  return { settings, droppedKeys, droppedEnvKeys }
}

export type SettingsRestoreResult = {
  settings: Record<string, unknown>
  /** What was put back, `env.X` for env entries. Empty means nothing to do. */
  restored: string[]
}

/**
 * The inverse of {@link stripCredentialsFromSettings}, for a credential top-up
 * run over a settings.json a previous credential-free run already wrote.
 *
 * Two rules, both load-bearing:
 *
 *  - Only keys the STRIP rules remove are candidates. Merging every missing key
 *    would resurrect settings the user deliberately deleted on the occ side.
 *  - A key already present on the occ side is never touched, whatever its
 *    value. `--force` means "do the run again", not "throw away my edits" —
 *    the same no-clobber rule every other part of the migration follows.
 */
export function restoreStrippedSettings(
  legacy: Record<string, unknown>,
  current: Record<string, unknown>,
): SettingsRestoreResult {
  const settings: Record<string, unknown> = { ...current }
  const restored: string[] = []

  for (const key of CREDENTIAL_SETTINGS_KEYS) {
    if (legacy[key] !== undefined && settings[key] === undefined) {
      settings[key] = legacy[key]
      restored.push(key)
    }
  }

  const legacyEnv = legacy.env
  if (legacyEnv && typeof legacyEnv === 'object' && !Array.isArray(legacyEnv)) {
    const currentEnv =
      settings.env &&
      typeof settings.env === 'object' &&
      !Array.isArray(settings.env)
        ? { ...(settings.env as Record<string, unknown>) }
        : {}
    for (const [envKey, envValue] of Object.entries(
      legacyEnv as Record<string, unknown>,
    )) {
      if (!isCredentialEnvKey(envKey)) continue
      if (currentEnv[envKey] !== undefined) continue
      currentEnv[envKey] = envValue
      restored.push(`env.${envKey}`)
    }
    if (Object.keys(currentEnv).length > 0) settings.env = currentEnv
  }

  return { settings, restored }
}

export type McpStripResult = {
  servers: Record<string, unknown>
  /** One human-readable line per server that lost something. */
  stripped: string[]
}

/**
 * Remove `env` and `headers` from MCP server definitions.
 *
 * Stripped wholesale rather than key-by-key: unlike `settings.env`, an MCP
 * server's `env` is free-form and server-specific, so there is no shape to
 * classify against and a heuristic would eventually leak a token.
 *
 * The keys are DELETED, not blanked. An empty-string secret is
 * indistinguishable from a real one to the server and produces a confusing
 * auth failure; an absent one fails loudly and correctly. The names go into
 * the migration report instead, so the user knows what to re-add.
 */
export function stripCredentialsFromMcpServers(
  servers: Record<string, unknown>,
): McpStripResult {
  const out: Record<string, unknown> = {}
  const stripped: string[] = []

  for (const [name, definition] of Object.entries(servers)) {
    if (
      !definition ||
      typeof definition !== 'object' ||
      Array.isArray(definition)
    ) {
      out[name] = definition
      continue
    }
    const { env, headers, ...rest } = definition as Record<string, unknown>
    const parts: string[] = []
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      const keys = Object.keys(env as Record<string, unknown>)
      if (keys.length > 0) parts.push(`env ${keys.join(', ')}`)
    }
    if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
      const keys = Object.keys(headers as Record<string, unknown>)
      if (keys.length > 0) parts.push(`headers ${keys.join(', ')}`)
    }
    out[name] = rest
    if (parts.length > 0) {
      stripped.push(
        `MCP ${name}: ${parts.join(' + ')} stripped — re-add before use`,
      )
    }
  }

  return { servers: out, stripped }
}

/**
 * MCP servers live in the legacy global config file (`~/.claude.json`), not in
 * the config directory, so they need reading separately.
 */
export function readLegacyMcpServers(
  fs: FsProbe,
): Record<string, unknown> | null {
  const legacy = readLegacyGlobalConfig(fs)
  const servers = legacy?.mcpServers
  if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
    return servers as Record<string, unknown>
  }
  return null
}

/**
 * Path of the official CLI's global state file, `~/.claude.json`.
 *
 * Derived from the migration's own source directory rather than re-reading
 * `legacyClaudeConfigDir()`. They are the same in production, but taking it
 * from the plan keeps executeMigration self-consistent — and stops it reaching
 * for the real home directory behind the caller's back, which is what made it
 * untestable and, in a sandbox, made it read the developer's own config.
 */
function legacyGlobalConfigFile(
  sourceDir: string = legacyClaudeConfigDir(),
): string {
  // Sits next to the legacy config dir, mirroring the shape
  // occGlobalConfigFile() produces for occ itself.
  return join(sourceDir, '..', '.claude.json')
}

function readLegacyGlobalConfig(fs: FsProbe): Record<string, unknown> | null {
  const path = legacyGlobalConfigFile()
  if (!fs.exists(path)) return null
  try {
    const parsed = JSON.parse(fs.readFile(path)) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // Malformed legacy config is not fatal — the rest of the migration is
    // still worth running.
  }
  return null
}

export type MigrationResult = {
  copied: string[]
  mcpServersImported: number
  errors: string[]
  /**
   * Credential outcomes and strip notices, verbatim for both the CLI report
   * and the wizard's completion screen.
   */
  notes: string[]
  /**
   * True when occ gained a login it did not have before. Drives the
   * shared-refresh-token warning, which only applies to a token we copied.
   */
  credentialsMigrated: boolean
  /**
   * True when occ holds a login now, copied or pre-existing. Drives "the
   * wizard can skip /login", which is true either way.
   */
  credentialsAvailable: boolean
}

export type ExecuteMigrationDeps = {
  /**
   * Overridden in tests; production copies the real login.
   *
   * Injected rather than mocked: the real implementation spawns `security`,
   * and Bun's `mock.module` is process-global, so substituting the credential
   * module for one suite would substitute it for every suite that ran after —
   * including the one that tests the real thing.
   */
  migrateCredentials?: () => Promise<CredentialMigrationOutcome>
}

export type GlobalConfigMerge = {
  changed: boolean
  mcpServersImported: number
  notes: string[]
  /**
   * Account keys that apply() actually wrote. Populated BY apply(), because
   * no-clobber means "would write" and "did write" are different answers and
   * only the second one may be reported to the user or recorded in the marker.
   */
  accountKeysWritten: string[]
  apply: (current: Record<string, unknown>) => Record<string, unknown>
}

/**
 * Compute the `~/.occ.json` merge from the legacy `~/.claude.json`.
 *
 * Pure so the account-key and MCP merge rules can be tested without touching a
 * real config file. Every branch is no-clobber: an occ value that already
 * exists always wins, because this is an import, not a takeover.
 */
export function buildGlobalConfigMerge(
  legacyGlobal: Record<string, unknown>,
  options: {
    migrateCredentials: boolean
    /** False on a credentials-only top-up, where files were already migrated. */
    includeMcpServers: boolean
    /** Legacy keychain API key discovered by the credential step. */
    apiKey?: string | null
  },
): GlobalConfigMerge {
  const notes: string[] = []
  const steps: Array<
    (current: Record<string, unknown>) => Record<string, unknown>
  > = []
  let mcpServersImported = 0

  const rawServers = legacyGlobal.mcpServers
  if (
    options.includeMcpServers &&
    rawServers &&
    typeof rawServers === 'object' &&
    !Array.isArray(rawServers)
  ) {
    let servers = rawServers as Record<string, unknown>
    if (!options.migrateCredentials) {
      const result = stripCredentialsFromMcpServers(servers)
      servers = result.servers
      notes.push(...result.stripped)
    }
    mcpServersImported = Object.keys(servers).length
    if (mcpServersImported > 0) {
      steps.push(current => {
        const existing =
          current.mcpServers &&
          typeof current.mcpServers === 'object' &&
          !Array.isArray(current.mcpServers)
            ? (current.mcpServers as Record<string, unknown>)
            : {}
        // Existing occ entries win.
        return { ...current, mcpServers: { ...servers, ...existing } }
      })
    }
  }

  const rawEnv = legacyGlobal.env
  if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
    let env = rawEnv as Record<string, unknown>
    if (!options.migrateCredentials) {
      const dropped: string[] = []
      const kept: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(env)) {
        if (isCredentialEnvKey(key)) {
          dropped.push(key)
          continue
        }
        kept[key] = value
      }
      env = kept
      if (dropped.length > 0) {
        notes.push(`~/.claude.json env: ${dropped.join(', ')} stripped`)
      }
    }
    if (Object.keys(env).length > 0) {
      steps.push(current => {
        const existing =
          current.env &&
          typeof current.env === 'object' &&
          !Array.isArray(current.env)
            ? (current.env as Record<string, unknown>)
            : {}
        return { ...current, env: { ...env, ...existing } }
      })
    }
  }

  const accountKeysWritten: string[] = []
  if (options.migrateCredentials) {
    const account: Record<string, unknown> = {}
    for (const key of LEGACY_ACCOUNT_CONFIG_KEYS) {
      const value = legacyGlobal[key]
      if (value !== undefined) account[key] = value
    }
    // The keychain API key is a fallback source for the same field, so it must
    // not displace an explicit `primaryApiKey` from the legacy config file.
    if (options.apiKey && account.primaryApiKey === undefined) {
      account.primaryApiKey = options.apiKey
    }
    if (Object.keys(account).length > 0) {
      steps.push(current => {
        const next = { ...current }
        for (const [key, value] of Object.entries(account)) {
          // No-clobber: never overwrite an occ value the user already has.
          if (next[key] !== undefined) continue
          next[key] = value
          accountKeysWritten.push(key)
        }
        return next
      })
    }
  }

  return {
    changed: steps.length > 0,
    mcpServersImported,
    notes,
    accountKeysWritten,
    apply: current => {
      accountKeysWritten.length = 0
      return steps.reduce((acc, step) => step(acc), current)
    },
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'EEXIST'
  )
}

/**
 * Perform the copy described by `plan`.
 *
 * Deliberately not transactional: a partial migration leaves the user with
 * some of their config rather than none, and every individual copy is
 * skip-if-exists, so re-running finishes the job. Failures are collected
 * rather than thrown so one unreadable directory cannot abort the rest.
 *
 * The `.migrated` marker is written even on partial success — re-running is
 * available via `occ migrate --force`, and we must not re-prompt on every
 * startup because one plugin directory had bad permissions.
 */
export async function executeMigration(
  plan: MigrationPlan,
  deps: ExecuteMigrationDeps = {},
): Promise<MigrationResult> {
  const { cp, copyFile, mkdir, readFile, writeFile } = await import(
    'node:fs/promises'
  )
  const { constants: fsConstants } = await import('node:fs')
  const result: MigrationResult = {
    copied: [],
    mcpServersImported: 0,
    errors: [],
    notes: [],
    credentialsMigrated: false,
    credentialsAvailable: false,
  }

  await mkdir(plan.targetDir, { recursive: true })

  for (const item of plan.items) {
    try {
      if (!plan.migrateCredentials && item.name === 'settings.json') {
        // Rewritten rather than copied: the file is worth migrating for theme,
        // permissions, routing and the rest, but the credential-resolving keys
        // and the secret half of `env` must not ride along. Unparseable input
        // is skipped rather than half-written.
        const raw = await readFile(item.from, 'utf8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const { settings, droppedKeys, droppedEnvKeys } =
          stripCredentialsFromSettings(parsed)
        await writeFile(item.to, `${JSON.stringify(settings, null, 2)}\n`, {
          flag: 'wx',
        })
        const dropped = [
          ...droppedKeys,
          ...droppedEnvKeys.map(key => `env.${key}`),
        ]
        result.copied.push(
          dropped.length > 0
            ? `${item.name} (stripped ${dropped.join(', ')})`
            : item.name,
        )
        continue
      }

      if (item.kind === 'dir') {
        // Claim the whole destination atomically. Recursive mkdir/cp would merge
        // into a directory another occ process created after planning.
        try {
          await mkdir(item.to)
        } catch (error) {
          if (isAlreadyExistsError(error)) continue
          throw error
        }
        await cp(item.from, item.to, {
          recursive: true,
          force: false,
          errorOnExist: true,
        })
      } else {
        // COPYFILE_EXCL closes the same plan/execute race for ordinary files.
        await copyFile(item.from, item.to, fsConstants.COPYFILE_EXCL)
      }
      result.copied.push(item.name)
    } catch (error) {
      if (isAlreadyExistsError(error)) continue
      result.errors.push(`${item.name}: ${(error as Error).message}`)
    }
  }

  // Put back what an earlier credential-free run stripped out of a
  // settings.json that already exists on the occ side. The per-item copy above
  // cannot do this: no-clobber (rightly) refuses to touch an existing file, so
  // without this step `--with-credentials` silently failed to deliver the
  // `env` keys and auth hooks it advertises on any second run.
  if (plan.settingsSecretTopUp.length > 0) {
    const occSettings = join(plan.targetDir, 'settings.json')
    try {
      const legacy = JSON.parse(
        await readFile(join(plan.sourceDir, 'settings.json'), 'utf8'),
      ) as Record<string, unknown>
      const current = JSON.parse(await readFile(occSettings, 'utf8')) as Record<
        string,
        unknown
      >
      const { settings, restored } = restoreStrippedSettings(legacy, current)
      if (restored.length > 0) {
        await writeFile(occSettings, `${JSON.stringify(settings, null, 2)}\n`)
        result.notes.push(
          `settings.json: restored ${restored.join(', ')} (existing values left as they were)`,
        )
      }
    } catch (error) {
      result.errors.push(`settings.json: ${(error as Error).message}`)
    }
  }

  // Credentials first: the API key it finds feeds the config merge below, and
  // a locked keychain should be reported before we claim success.
  let legacyApiKey: string | null = null
  let oauthWritten = false
  let oauthAvailable = false
  if (
    plan.migrateCredentials &&
    (plan.forced || !plan.credentialsAlreadyMigrated)
  ) {
    try {
      const migrate =
        deps.migrateCredentials ??
        (await import('./migrateCredentials.js')).migrateLegacyCredentials
      const outcome = await migrate()
      result.notes.push(...outcome.notes)
      result.errors.push(...outcome.errors)
      oauthWritten = outcome.migrated
      oauthAvailable = outcome.oauthAvailable
      legacyApiKey = outcome.apiKey
    } catch (error) {
      result.errors.push(`credentials: ${(error as Error).message}`)
    }
  }

  // MCP servers and the account-identity keys live in the legacy GLOBAL file,
  // so they are merged rather than copied. Written through saveGlobalConfig
  // rather than straight to disk: the wizard runs inside a process that
  // already has ~/.occ.json cached, and a raw file write would be silently
  // overwritten by the next config save.
  const legacyGlobalPath = legacyGlobalConfigFile(plan.sourceDir)
  let accountKeysWritten: readonly string[] = []
  let legacyGlobal: Record<string, unknown> | null = null
  const rawLegacyGlobal = await readFile(legacyGlobalPath, 'utf8').catch(
    () => null,
  )
  if (rawLegacyGlobal !== null) {
    try {
      legacyGlobal = JSON.parse(rawLegacyGlobal) as Record<string, unknown>
    } catch (error) {
      // A note, not an error: the plan phase already treats an unparseable
      // legacy global as "nothing to import" rather than a failure, and
      // exiting 1 over the OFFICIAL CLI's broken file would make the whole
      // migration look failed. Name the file that is actually broken.
      result.notes.push(
        `${legacyGlobalPath} is not valid JSON (${(error as Error).message}) — skipped MCP servers and account keys.`,
      )
    }
  }
  if (legacyGlobal) {
    const merge = buildGlobalConfigMerge(legacyGlobal, {
      migrateCredentials: plan.migrateCredentials,
      includeMcpServers: !plan.credentialsOnly,
      apiKey: legacyApiKey,
    })
    result.notes.push(...merge.notes)
    if (merge.changed) {
      try {
        const { enableConfigs, saveGlobalConfig } = await import(
          '../utils/config/config.js'
        )
        // `occ migrate` runs BEFORE the normal bootstrap (see the handler's
        // header), so nothing has opened the config system yet and getConfig()
        // would throw "Config accessed before allowed". Idempotent, and a
        // no-op on the wizard path where bootstrap already ran.
        enableConfigs()
        saveGlobalConfig(
          current =>
            merge.apply(current as unknown as Record<string, unknown>) as never,
        )
        result.mcpServersImported = merge.mcpServersImported
        accountKeysWritten = merge.accountKeysWritten
        if (accountKeysWritten.length > 0) {
          // Reported only now, from what apply() actually wrote — no-clobber
          // may have refused every one of them. Reporting them is NOT the same
          // as claiming a login: see resolveCredentialOutcome().
          result.notes.push(
            `${occGlobalConfigFile()}: imported ${accountKeysWritten.join(', ')}`,
          )
        }
      } catch (error) {
        result.errors.push(
          `${occGlobalConfigFile()}: ${(error as Error).message}`,
        )
      }
    }
  }

  // Record WHAT ran, not just THAT it ran, so a later --with-credentials can
  // top up instead of being short-circuited. "Done" means occ CAN AUTHENTICATE
  // now, which includes the case where it already had a login and no-clobber
  // kept it — otherwise that user would be re-offered the top-up forever. A run
  // that copied only identity records, or found nothing at all, stays
  // retryable without --force.
  const credentials = resolveCredentialOutcome({
    oauthWritten,
    oauthAvailable,
    accountKeysWritten,
  })
  result.credentialsMigrated = credentials.credentialsMigrated
  result.credentialsAvailable = credentials.credentialsAvailable
  const marker: MigrationMarker = {
    migratedAt: new Date().toISOString(),
    sourceDir: plan.sourceDir,
    credentials: plan.credentialsAlreadyMigrated || result.credentialsAvailable,
  }
  await writeFile(
    join(plan.targetDir, MIGRATION_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
  )

  return result
}

/**
 * Human-readable summary shown before asking the user to confirm.
 *
 * `modeDetails: false` drops everything that depends on which mode was chosen
 * — the strip list and the credentials paragraph. The first-run wizard needs
 * that: it renders this summary ABOVE the three options, so a plan built in the
 * default mode would sit there promising "will NOT copy credentials" while the
 * user's cursor is on "copy everything including account credentials".
 */
export function describeMigrationPlan(
  plan: MigrationPlan,
  options: { modeDetails?: boolean } = {},
): string {
  const modeDetails = options.modeDetails !== false
  if (!plan.sourceExists) {
    return `No existing Claude Code configuration found at ${plan.sourceDir}.`
  }
  if (plan.credentialsOnly) {
    const lines = [
      `Already migrated from ${plan.sourceDir}, but without credentials.`,
      '',
      'Would copy:',
      "  your Claude Code login (OAuth token / API key) into open-claude-code's",
      '  own storage',
    ]
    if (plan.settingsSecretTopUp.length > 0) {
      lines.push(
        `  into ${join(plan.targetDir, 'settings.json')}, the secrets the first run stripped:`,
      )
      for (const name of plan.settingsSecretTopUp) {
        lines.push(`    ${name}`)
      }
      lines.push(
        '',
        'Values you have already set on the open-claude-code side are left as',
        'they are — this fills gaps, it does not overwrite.',
      )
    } else {
      lines.push('', 'No settings.json secrets left to restore.')
    }
    lines.push(
      `MCP server definitions and files are not re-copied; ${plan.sourceDir} is left untouched.`,
    )
    return lines.join('\n')
  }
  if (plan.alreadyMigrated && !plan.forced) {
    return `Already migrated (${join(plan.targetDir, MIGRATION_MARKER)} exists).`
  }
  if (
    plan.items.length === 0 &&
    plan.mcpServerCount === 0 &&
    plan.settingsSecretTopUp.length === 0
  ) {
    return `Nothing to migrate from ${plan.sourceDir}.`
  }

  const lines = [
    `Found an existing Claude Code setup at ${plan.sourceDir}.`,
    `open-claude-code keeps its own configuration in ${plan.targetDir}, so the two do not interfere.`,
    '',
    'Would copy:',
  ]
  for (const item of plan.items) {
    lines.push(`  ${item.name}${item.kind === 'dir' ? '/' : ''}`)
  }
  if (plan.mcpServerCount > 0) {
    lines.push(
      `  ${plan.mcpServerCount} MCP server${plan.mcpServerCount === 1 ? '' : 's'}`,
    )
  }
  if (modeDetails && plan.migrateCredentials) {
    lines.push('  your login (OAuth token / API key)')
    if (plan.settingsSecretTopUp.length > 0) {
      lines.push(
        `  into the existing ${join(plan.targetDir, 'settings.json')}: ${plan.settingsSecretTopUp.join(', ')}`,
      )
    }
  }

  if (modeDetails && plan.strippedItems.length > 0) {
    lines.push('', 'Stripped as credentials (your choice) — re-enter these:')
    for (const name of plan.strippedItems) {
      lines.push(`  ${name}`)
    }
  }

  if (modeDetails && plan.unclassifiedItems.length > 0) {
    lines.push('', 'Copied as-is (no rule can tell config from secret here):')
    for (const name of plan.unclassifiedItems) {
      lines.push(`  ${name}`)
    }
  }

  lines.push('')
  if (modeDetails) {
    if (plan.migrateCredentials) {
      lines.push(
        'Will copy credentials, so open-claude-code works without a fresh /login.',
        'Both CLIs will then share one refresh token: whichever refreshes first',
        'invalidates the other, so expect to /login again on the one you use less.',
      )
    } else {
      lines.push(
        'Will NOT copy credentials — sign in again with /login. Endpoints, model',
        'IDs and context-window settings are kept; only secrets are stripped.',
      )
    }
  }
  lines.push(
    'Session history is never copied.',
    `${plan.sourceDir} is left untouched.`,
    `Target global config: ${occGlobalConfigFile()}`,
  )
  return lines.join('\n')
}
