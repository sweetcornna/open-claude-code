import { describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  BIN_NAME,
  DEEP_LINK_PROTOCOL,
  MACOS_DEEP_LINK_BUNDLE_ID,
  NPM_PACKAGE_NAME,
} from 'src/constants/brand.js'
import {
  occConfigDir,
  occConfigPath,
  occGlobalConfigFile,
} from 'src/config/paths.js'
import { SYNC_KEYS } from 'src/services/settingsSync/types.js'
import {
  buildDeepLink,
  parseDeepLink,
} from 'src/utils/deepLink/parseDeepLink.js'
import { filterOccAliases } from 'src/utils/shell/shellConfig.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from 'src/utils/settings/settings.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'

const sourceRoot = resolve(import.meta.dir, '..', '..')

function readSource(relativePath: string): string {
  return readFileSync(resolve(sourceRoot, relativePath), 'utf8')
}

// The Commander program definition was split out of main.tsx into
// src/cli/program/ (S7-4b). Isolation assertions that used to scan main.tsx
// must cover the whole program tree, or they silently assert on a shim.
function readProgramSources(): string {
  const programDir = resolve(sourceRoot, 'cli', 'program')
  const files = readdirSync(programDir, { recursive: true })
    .map(String)
    .filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
    .sort()
  return [
    readSource('main.tsx'),
    ...files.map(name => readFileSync(resolve(programDir, name), 'utf8')),
  ].join('\n')
}

const UPGRADE_CREDENTIAL_FILES = [
  'gemini-antigravity-auth.json',
  'openai-chatgpt-auth.json',
  '.credentials.json',
  'provider-profiles.json',
] as const

type UpgradeSnapshot = {
  credentials: Record<string, string>
  globalState: string
  search: {
    webSearchAdapter?: unknown
    webSearchSources?: unknown
    braveApiKey?: unknown
    exaApiKey?: unknown
    env?: unknown
  }
}

function takeUpgradeSnapshot(): UpgradeSnapshot {
  const settings = JSON.parse(
    readFileSync(occConfigPath('settings.json'), 'utf8'),
  ) as Record<string, unknown>
  return {
    credentials: Object.fromEntries(
      UPGRADE_CREDENTIAL_FILES.map(file => [
        file,
        readFileSync(occConfigPath(file), 'utf8'),
      ]),
    ),
    globalState: readFileSync(occGlobalConfigFile(), 'utf8'),
    search: {
      webSearchAdapter: settings.webSearchAdapter,
      webSearchSources: settings.webSearchSources,
      braveApiKey: settings.braveApiKey,
      exaApiKey: settings.exaApiKey,
      env: settings.env,
    },
  }
}

describe('occ update isolation', () => {
  test('targets only the open-claude-code package', () => {
    const source = readSource('cli/updateOcc.ts')

    expect(NPM_PACKAGE_NAME).toBe('@sweetcornna/open-claude-code')
    expect(source).toContain('const PACKAGE_NAME = NPM_PACKAGE_NAME')
    expect(source).not.toContain('@anthropic-ai/claude-code')
  })

  // README is one of the five places the package name is pinned (see CLAUDE.md) and was the only
  // one with no guard. It drifted to the unscoped `open-claude-code`, which on npm is a squatted
  // 0.0.0 stub with no `bin`: `npm i -g` prints "added 1 package" and installs no `occ` at all, so
  // the one-line quick start silently produced a broken install that looked like a success.
  // All three translations are checked because the drift hit en and ja while zh was already fixed —
  // whichever file a reader lands on is the one that has to work.
  test.each([
    'README.md',
    'README.zh.md',
    'README.ja.md',
  ])('%s quick start installs the scoped package that actually ships occ', file => {
    const readme = readFileSync(resolve(sourceRoot, '..', file), 'utf8')
    const installLines = readme
      .split('\n')
      .filter(line => /^\s*(npm|bun|pnpm|yarn)\s.*-g\s/.test(line))
    expect(installLines.length).toBeGreaterThan(0)
    for (const line of installLines) {
      expect(line).toContain(NPM_PACKAGE_NAME)
      // Catches the exact drift: remove the correct scoped spelling, and any bare
      // `open-claude-code` still left on the line is an unscoped install target.
      const withoutScoped = line.split(NPM_PACKAGE_NAME).join('')
      expect(withoutScoped).not.toContain('open-claude-code')
    }
  })

  test('does not expose the inherited native installer command', () => {
    const source = readProgramSources()

    expect(source).not.toMatch(/\.command\(['"]install \[target\]['"]\)/)
    expect(source).not.toMatch(/\{\s*installHandler\s*\}/)
  })

  test('does not route background updates to official native channels', () => {
    // This used to inspect the React auto-updater components. They were
    // deleted once the live path moved to services/autoUpdate — nothing had
    // rendered them for a while. The occ half of the invariant is covered by
    // "silent background self-updater reuses only the occ update chain"
    // below; what remains uncovered is the plugin loop and Doctor.
    const pluginServiceSource = readSource(
      'services/autoUpdate/backgroundPluginUpdate.ts',
    )
    const doctorSource = readSource('screens/Doctor.tsx')

    for (const officialChannel of [
      '@anthropic-ai/claude-code',
      'Anthropic.ClaudeCode',
      'getLatestVersionFromGcs',
      'nativeInstaller',
    ]) {
      expect(pluginServiceSource, officialChannel).not.toContain(
        officialChannel,
      )
    }
    expect(doctorSource).not.toContain('getGcsDistTags')
  })

  test('doctor never diagnoses or removes the official installation', () => {
    const source = readSource('utils/runtime/doctorDiagnostic.ts')

    expect(source).toContain('which(BIN_NAME)')
    expect(source).toContain("join(npmPrefix, 'bin', BIN_NAME)")
    expect(source).toContain('NPM_PACKAGE_NAME')
    expect(source).not.toContain('@anthropic-ai/claude-code')
    expect(source).not.toContain("which('claude')")
    expect(source).not.toContain('.local/bin/claude')
    expect(source).not.toContain('claude install')
    expect(source).not.toContain('alias claude')
    expect(source).not.toContain('rm -rf')
  })

  test('background npm updates target only the occ package', () => {
    const updaterSource = readSource('utils/update/autoUpdater.ts')
    const localInstallerSource = readSource('utils/update/localInstaller.ts')

    expect(updaterSource).toContain('NPM_PACKAGE_NAME')
    expect(localInstallerSource).toContain('NPM_PACKAGE_NAME')
    expect(localInstallerSource).toMatch(/node_modules\/\.bin\/\$\{BIN_NAME\}/)
    expect(updaterSource).not.toContain('@anthropic-ai/claude-code')
    expect(localInstallerSource).not.toContain('@anthropic-ai/claude-code')
    expect(localInstallerSource).not.toContain("'claude'")
  })

  test('silent background self-updater reuses only the occ update chain', () => {
    const serviceSource = readSource(
      'services/autoUpdate/backgroundOccUpdate.ts',
    )
    const installerSource = readSource('services/autoUpdate/occInstaller.ts')
    const updateOccSource = readSource('cli/updateOcc.ts')

    // The background check must go through cli/updateOcc.ts (pinned above to
    // target only NPM_PACKAGE_NAME) — never a parallel install path.
    expect(serviceSource).toContain("import('src/cli/updateOcc.js')")
    expect(serviceSource).not.toContain('@anthropic-ai/claude-code')
    expect(serviceSource).not.toContain('nativeInstaller')
    expect(updateOccSource).toContain('export function latestPackageSpec')

    // The install is a detached child spawned here. It must never name a
    // package of its own: the spec is handed down from latestPackageSpec().
    expect(installerSource).toContain('install.spec')
    expect(installerSource).not.toContain('@anthropic-ai/claude-code')
    expect(installerSource).not.toContain('nativeInstaller')
    expect(installerSource).not.toContain("'claude'")
  })

  test('update paths cannot mutate persisted credentials or search settings', () => {
    const updaterSources = [
      readSource('cli/updateOcc.ts'),
      readSource('services/autoUpdate/backgroundOccUpdate.ts'),
      readSource('services/autoUpdate/occInstaller.ts'),
      readSource('services/autoUpdate/runtimeFarm.ts'),
      readSource('services/autoUpdate/runtimeFarmGc.ts'),
      readSource('utils/update/autoUpdater.ts'),
      readSource('utils/update/localInstaller.ts'),
    ].join('\n')

    for (const credentialMutation of [
      'removeAntigravityAuth',
      'removeChatGPTAuth',
      'removeApiKey',
      'getSecureStorage',
      'gemini-antigravity-auth.json',
      'openai-chatgpt-auth.json',
      'webSearchSources',
    ]) {
      expect(updaterSources).not.toContain(credentialMutation)
    }
  })

  test('an upgrade migration preserves the credential and Web Search snapshot', () => {
    const previousConfigDir = process.env.OCC_CONFIG_DIR
    const configDir = mkdtempSync(join(tmpdir(), 'occ-upgrade-snapshot-'))
    process.env.OCC_CONFIG_DIR = configDir
    occConfigDir.cache.clear?.()
    resetSettingsCache()

    try {
      mkdirSync(occConfigDir(), { recursive: true })
      writeFileSync(
        occConfigPath('settings.json'),
        `${JSON.stringify(
          {
            webSearchAdapter: 'deepseek',
            webSearchSources: {
              anthropic: true,
              deepseek: false,
              gemini: true,
              codex: false,
              brave: true,
              exa: false,
              free: true,
            },
            braveApiKey: 'brave-api-key-canary',
            exaApiKey: 'exa-api-key-canary',
            env: {
              ANTHROPIC_API_KEY: 'anthropic-api-key-canary',
              GEMINI_API_KEY: 'gemini-api-key-canary',
              OPENAI_API_KEY: 'openai-api-key-canary',
            },
            modelSettings: { opus: { effort: 'high' } },
          },
          null,
          2,
        )}\n`,
      )
      for (const file of UPGRADE_CREDENTIAL_FILES) {
        writeFileSync(occConfigPath(file), `${file}:credential-canary\n`)
      }
      writeFileSync(
        occGlobalConfigFile(),
        '{"primaryApiKey":"global-api-key-canary","migrationVersion":11}\n',
      )
      const before = takeUpgradeSnapshot()

      // Every install route converges on the next version's startup migrations.
      // Exercise the real read/merge/rewrite helper: this was the reachable path
      // that stripped nested source ids even though the updater deleted nothing.
      expect(
        updateSettingsForSource('userSettings', {
          modelSettings: { default: { effort: 'high' } },
        }),
      ).toEqual({ error: null })
      resetSettingsCache()

      expect(takeUpgradeSnapshot()).toEqual(before)
      expect(getSettingsForSource('userSettings')).toMatchObject(before.search)
    } finally {
      resetSettingsCache()
      if (previousConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
      else process.env.OCC_CONFIG_DIR = previousConfigDir
      occConfigDir.cache.clear?.()
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('alias cleanup preserves official Claude Code and custom aliases', () => {
    const managedAlias = `alias ${BIN_NAME}="${occConfigPath('local', BIN_NAME)}"`
    const officialAlias = 'alias claude="/usr/local/bin/claude"'
    const customOccAlias = `alias ${BIN_NAME}="/opt/custom/${BIN_NAME}"`

    expect(
      filterOccAliases([managedAlias, officialAlias, customOccAlias]),
    ).toEqual({
      filtered: [officialAlias, customOccAlias],
      hadAlias: true,
    })
  })

  test('deep links register an occ identity and reject the legacy protocol', () => {
    expect(DEEP_LINK_PROTOCOL).toBe('occ-cli')
    expect(MACOS_DEEP_LINK_BUNDLE_ID).not.toContain('anthropic')
    expect(buildDeepLink({ query: 'hello' })).toStartWith('occ-cli://open')
    expect(parseDeepLink(`${DEEP_LINK_PROTOCOL}://open?q=hello`)).toEqual({
      query: 'hello',
      cwd: undefined,
      repo: undefined,
    })
    // `claude-cli:` belongs to Anthropic's CLI. Accepting it would let the
    // official product's deep links drive occ.
    expect(() => parseDeepLink('claude-cli://open?q=legacy')).toThrow()

    const registrationSource = readSource('utils/deepLink/registerProtocol.ts')
    expect(registrationSource).toContain('MACOS_DEEP_LINK_BUNDLE_ID')
    expect(registrationSource).toMatch(/`\$\{BIN_NAME\}\.exe`/)
    expect(registrationSource).not.toContain('com.anthropic')
    expect(registrationSource).not.toContain("'claude.exe'")
    expect(registrationSource).not.toContain(
      "'claude-code-url-handler.desktop'",
    )
  })

  test('settings sync uses an occ-owned remote namespace', () => {
    expect(SYNC_KEYS.USER_SETTINGS).toBe('~/.occ/settings.json')
    expect(SYNC_KEYS.USER_MEMORY).toBe('~/.occ/CLAUDE.md')
    expect(SYNC_KEYS.projectSettings('project-id')).toBe(
      'projects/project-id/.occ/settings.local.json',
    )
    expect(Object.values(SYNC_KEYS).join(' ')).not.toContain('~/.claude')
  })

  test('Windows backup cleanup targets only occ executables', () => {
    const source = readSource('utils/nativeInstaller/installer.ts')
    expect(source).toMatch(
      /`\^\$\{BIN_NAME\}\\\\\.exe\\\\\.old\\\\\.\\\\d\+\$`/,
    )
    expect(source).not.toContain('/^claude\\.exe\\.old\\.\\d+$/')
  })

  test('background housekeeping never mutates the official npm cache', () => {
    const cleanupSource = readSource('utils/process/cleanup.ts')
    const housekeepingSource = readSource(
      'utils/agents/backgroundHousekeeping.ts',
    )

    expect(cleanupSource).not.toContain('cleanupNpmCacheForAnthropicPackages')
    expect(cleanupSource).not.toContain("join(homedir(), '.npm', '_cacache')")
    expect(cleanupSource).not.toContain("entry.key.includes('@anthropic-ai/")
    expect(housekeepingSource).not.toContain(
      'cleanupNpmCacheForAnthropicPackages',
    )
  })

  test('native installer exposes no official npm cleanup capability', () => {
    const installerSource = readSource('utils/nativeInstaller/installer.ts')
    const indexSource = readSource('utils/nativeInstaller/index.ts')

    for (const source of [installerSource, indexSource]) {
      expect(source).not.toContain('cleanupNpmInstallations')
    }
    expect(installerSource).not.toContain("['uninstall', '-g'")
    expect(installerSource).not.toContain("join(globalPrefix, 'claude.cmd')")
    expect(installerSource).not.toContain("join(globalPrefix, 'claude.ps1')")
    expect(installerSource).not.toContain("join(globalPrefix, 'bin', 'claude')")
  })

  test('optional runtimes use occ-owned process identities', () => {
    const executorSource = readSource(
      'utils/computerUse/executorCrossPlatform.ts',
    )
    const panelSource = readSource('utils/terminal/terminalPanel.ts')
    const powershellSource = readSource('utils/shell/powershellProvider.ts')
    // addSlowOperation moved out of the (now re-export-only) bootstrap/state.ts
    // barrel when it was split into leaf modules; the assertions below are
    // unchanged, only the file that carries the check.
    const bootstrapSource = readSource('bootstrap/state/sessionRuntime.ts')
    const shareSource = readSource('commands/share/index.ts')
    // The transcript v-for-editor handler moved out of REPL.tsx when the
    // transcript search cluster was extracted; the assertion below is
    // unchanged, only the file that carries the check.
    const replSource = readSource('screens/repl/useTranscriptSearch.ts')
    const executorContract = readFileSync(
      resolve(
        sourceRoot,
        '..',
        'packages/@ant/computer-use-mcp/src/executor.ts',
      ),
      'utf8',
    )

    expect(executorContract).toContain("agent: 'self' | 'codex'")
    expect(executorContract).not.toContain("agent: 'claude' | 'codex'")
    expect(executorSource).toContain('self: BIN_NAME')
    expect(executorSource).not.toContain("claude: 'claude'")
    expect(panelSource).toMatch(/`\$\{BIN_NAME\}-panel-\$\{sessionId/)
    expect(panelSource).toMatch(/\$\{DISPLAY_NAME\}/)
    expect(panelSource).not.toContain('`claude-panel-${sessionId')
    expect(panelSource).not.toContain('return to Open Claude Code')
    expect(powershellSource).toMatch(/`\$\{BIN_NAME\}-pwd-ps-\$\{opts\.id\}`/)
    expect(powershellSource).not.toMatch(/`claude-pwd-ps-\$\{opts\.id\}`/)
    expect(bootstrapSource).toMatch(/`\$\{BIN_NAME\}-prompt-`/)
    expect(bootstrapSource).not.toContain(
      "operation.includes('claude-prompt-')",
    )
    expect(shareSource).toContain('SHARE_TEMP_PREFIX')
    expect(shareSource).toContain('SESSION_EXPORT_FILENAME')
    expect(shareSource).not.toContain("'cc-share-'")
    expect(shareSource).not.toContain('claude-session.jsonl')
    expect(replSource).toContain(
      "generateTempFilePath(TRANSCRIPT_TEMP_PREFIX, '.txt')",
    )
    expect(replSource).not.toContain('cc-transcript-')
  })

  test('IDE compatibility never mutates official lockfiles or extensions', () => {
    const source = readSource('utils/terminal/ide.ts')

    expect(source).toContain('canDeleteIdeLockfile(lockfilePath)')
    expect(source).not.toContain("'--install-extension'")
    expect(source).not.toContain('installFromArtifactory')
    expect(source).not.toContain('tengu_ext_installed')
  })

  test('core CLI help and handlers invoke only the occ binary', () => {
    const programSource = readProgramSources()
    const entrySource = readSource('entrypoints/cli.tsx')
    const bgSource = readSource('cli/bg.ts')
    const jobsSource = readSource('cli/handlers/templateJobs.ts')
    const mcpSource = readSource('cli/handlers/mcp.tsx')
    const authSource = readSource('cli/handlers/auth.ts')
    const pluginsSource = readSource('cli/handlers/plugins.ts')
    const rollbackSource = readSource('cli/rollback.ts')

    expect(programSource).toContain('.name(BIN_NAME)')
    expect(programSource).toMatch(
      /\$\{DISPLAY_NAME\} - starts an interactive session/,
    )
    expect(entrySource).toMatch(/Use: \$\{BIN_NAME\} daemon/)
    expect(entrySource).toMatch(/Use: \$\{BIN_NAME\} job/)
    // Session names are `<bin>-bg-<jobId>`; the job id is now generated one
    // line earlier so the job record and the session share it.
    expect(bgSource).toMatch(/`\$\{BIN_NAME\}-bg-\$\{jobId\}`/)
    expect(bgSource).toMatch(/const jobId = randomUUID\(\)\.slice\(0, 8\)/)
    expect(jobsSource).toContain("occConfigPath('templates')")

    for (const source of [
      programSource,
      entrySource,
      bgSource,
      jobsSource,
      mcpSource,
      authSource,
      pluginsSource,
      rollbackSource,
    ]) {
      expect(source).not.toMatch(
        /(?:Usage:|Run|run|Use|use|Resume with:|You must run| {2}) [`'"\\]*claude (?:--|auth|assistant|daemon|job|mcp|plugin|rollback)/,
      )
    }
  })

  test('Remote Control guidance invokes only the occ binary', () => {
    const bridgeEnabledSource = readSource('bridge/bridgeEnabled.ts')

    expect(bridgeEnabledSource).toMatch(/\\`\$\{BIN_NAME\} auth login\\`/)
    expect(bridgeEnabledSource).toMatch(/\\`\$\{BIN_NAME\} update\\`/)
    expect(bridgeEnabledSource).not.toMatch(/`claude (?:auth login|update)/)
  })
})
