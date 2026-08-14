// Golden (characterization) tests for the real CLI argument surface.
//
// Why a subprocess: `src/main.tsx` is ~5,300 lines and registers the whole
// Commander program as a side effect of `main()`. Importing it in-process
// drags in the interactive bootstrap, so the only honest way to pin what the
// CLI *actually* accepts is to run it and read stdout/stderr.
//
// Why it is worth the wall-clock cost: `tests/integration/cli-arguments.test.ts`
// builds a small REPLICA Commander program and asserts on that — it can never
// catch a command or flag disappearing from `main.tsx`. This file is the first
// coverage of the real thing, recorded before `main.tsx` gets split apart so
// the split can be proven behaviour-preserving.
//
// Notes on determinism:
//   - The entrypoint is run directly (`bun src/entrypoints/cli.tsx`) with no
//     `--feature` flags, so every `feature()` gate is OFF. Feature-gated
//     commands (`auto-mode`, `remote-control`, `ssh`, …) are therefore absent
//     from the recorded help output on purpose. `bun run dev` / `bun run build`
//     enable DEFAULT_BUILD_FEATURES and would show more.
//   - `USER_TYPE` is stripped from the child environment, so `[ANT-ONLY]`
//     commands stay hidden except in the one case that sets it explicitly.
//   - cwd is the repo root: Bun resolves the `src/*` tsconfig path alias from
//     the child's cwd, not from the entrypoint's directory.
//
// Assertions favour the *shape* of the surface (usage line, the set of
// subcommand names, the set of option flags) over byte-exact help text, so
// rewording a description does not fail the suite but adding, renaming, or
// dropping a command or flag does.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dir, '../..')
const CLI_ENTRYPOINT = 'src/entrypoints/cli.tsx'

// A cold boot of the full Commander program costs ~10-30s (every `--help`
// path still evaluates main.tsx). The spawns are therefore batched once in
// `beforeAll` with bounded concurrency, and each test only asserts against
// the recorded result.
const SPAWN_CONCURRENCY = 3
const SPAWN_TIMEOUT_MS = 120_000
const BATCH_TIMEOUT_MS = 600_000
const ASSERT_TIMEOUT_MS = 30_000

/**
 * Environment variables removed from the child so a developer's shell cannot
 * change the recorded output. `USER_TYPE` gates whole command trees,
 * `CLAUDE_CODE_VERSION` rewrites the version string, and the credential /
 * provider variables exist so that a run which is supposed to fail during
 * argument parsing cannot reach an API even if parsing regressed.
 *
 * `NODE_ENV` is deliberately NOT stripped. `bun test` exports `NODE_ENV=test`,
 * so every child here inherits it, and that is the point: the credential
 * lookup takes a throwing branch under `NODE_ENV=test` / `CI` when no key is
 * present, and swallowing that difference is how a startup hang stayed
 * invisible (see the "boots under NODE_ENV=test / CI" describe block below).
 */
const STRIPPED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_FORCE_INTERACTIVE',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_VERSION',
  'USER_TYPE',
]

type CliResult = {
  args: string[]
  exitCode: number | null
  stderr: string
  stdout: string
}

const configDir = mkdtempSync(join(tmpdir(), 'occ-cli-golden-'))

function childEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  for (const key of STRIPPED_ENV_KEYS) delete env[key]
  // Both roots point at a throwaway directory: OCC_CONFIG_DIR wins, but the
  // deprecated CLAUDE_CONFIG_DIR fallback must not point at real user config
  // either.
  env.OCC_CONFIG_DIR = configDir
  env.CLAUDE_CONFIG_DIR = configDir
  env.NO_COLOR = '1'
  return { ...env, ...overrides }
}

async function runCli(
  args: string[],
  overrides: Record<string, string> = {},
): Promise<CliResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRYPOINT, ...args],
    cwd: PROJECT_ROOT,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: childEnv(overrides),
  })
  // Watchdog: a hung child would otherwise fail the whole batch hook with no
  // indication of which invocation was responsible.
  const watchdog = setTimeout(() => proc.kill(9), SPAWN_TIMEOUT_MS)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { args, exitCode, stderr, stdout }
  } finally {
    clearTimeout(watchdog)
  }
}

// Every subprocess this file starts. Keep this list small: each entry is a
// full CLI cold boot.
const INVOCATIONS: Record<
  string,
  { args: string[]; env?: Record<string, string> }
> = {
  'root-help': { args: ['--help'] },
  version: { args: ['--version'] },
  'agents-help': { args: ['agents', '--help'] },
  'mcp-help': { args: ['mcp', '--help'] },
  'auth-help': { args: ['auth', '--help'] },
  'plugin-help': { args: ['plugin', '--help'] },
  'plugin-eval-help': { args: ['plugin', 'eval', '--help'] },
  'autonomy-help': { args: ['autonomy', '--help'] },
  'doctor-help': { args: ['doctor', '--help'] },
  'task-help': { args: ['task', '--help'], env: { USER_TYPE: 'ant' } },
  'update-help': { args: ['update', '--help'] },
  'unknown-flag': { args: ['--definitely-not-a-real-flag'] },
  'bogus-output-format': {
    args: ['-p', '--output-format', 'bogus', 'hello'],
  },
  // Value-acceptance probes. Pairing the value under test with a known-bad
  // flag makes the run fail inside Commander either way, so the assertion is
  // *which* error came out — no session is ever started, no network touched.
  'effort-xhigh': {
    args: ['--effort', 'xhigh', '--definitely-not-a-real-flag'],
  },
  'effort-bogus': {
    args: ['--effort', 'turbo', '--definitely-not-a-real-flag'],
  },
  'permission-mode-manual': {
    args: ['--permission-mode', 'manual', '--definitely-not-a-real-flag'],
  },
  // --forward-subagent-text without --output-format=stream-json. The run
  // stops at the rootAction guard that owns the flag, which is the proof the
  // parsed value travelled from Commander into the action handler — something
  // a --help grep cannot show.
  //
  // Only this one of the three print-mode-only flags can be probed here.
  // The other two guard on `!isNonInteractiveSession`, and this harness pipes
  // stdout, which already makes the session non-interactive — so their guards
  // correctly stay silent and the run proceeds into an interactive boot that
  // the watchdog has to SIGKILL. They get acceptance probes instead.
  'forward-subagent-text-without-stream-json': {
    args: ['-p', '--forward-subagent-text', 'hi'],
  },
  // Acceptance probes: the flag plus its value, paired with a known-bad flag
  // so Commander aborts either way. Failing on the bogus flag rather than on
  // the value is what proves the option and its argument parsed.
  'forward-subagent-text-accepted': {
    args: [
      '-p',
      '--output-format',
      'stream-json',
      '--forward-subagent-text',
      '--definitely-not-a-real-flag',
    ],
  },
  'plan-mode-instructions-accepted': {
    args: [
      '-p',
      '--plan-mode-instructions',
      'Step 1: read the ticket.',
      '--definitely-not-a-real-flag',
    ],
  },
  'append-subagent-system-prompt-accepted': {
    args: [
      '-p',
      '--append-subagent-system-prompt',
      'be terse',
      '--definitely-not-a-real-flag',
    ],
  },
}

const recorded = new Map<string, CliResult>()

function golden(name: keyof typeof INVOCATIONS): CliResult {
  const result = recorded.get(name)
  if (!result) throw new Error(`No recorded CLI run for "${name}"`)
  return result
}

/**
 * Extract the left-hand terms of a Commander help section.
 *
 * Commander indents each entry by exactly two spaces and separates the term
 * from its description by two or more spaces:
 *
 *     Commands:
 *       list [options]      List configured MCP servers
 *
 * Wrapped description lines are indented to the description column, and the
 * `mcp add` entry embeds a whole example block in its description — both are
 * skipped because they do not have a term followed by a description gap at
 * indent level two.
 */
function sectionTerms(help: string, section: string): string[] {
  const lines = help.split('\n')
  const start = lines.indexOf(`${section}:`)
  if (start === -1) return []
  const terms: string[] = []
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index] ?? ''
    // A non-indented, non-empty line means the section ended.
    if (/^\S/.test(line)) break
    const match = /^ {2}(\S.*?)\s{2,}\S/.exec(line)
    if (match?.[1]) terms.push(match[1])
  }
  return terms
}

/** Subcommand names (aliases kept, e.g. `plugin|plugins`). */
function commandNames(help: string): string[] {
  return sectionTerms(help, 'Commands').map(
    term => term.split(/\s+/)[0] as string,
  )
}

/** Every short and long flag declared in the Options section. */
function optionFlags(help: string): string[] {
  return sectionTerms(help, 'Options').flatMap(term => {
    // Drop `<value>` / `[value]` placeholders first: `<file-or-json>` would
    // otherwise contribute a phantom `-or-json` flag.
    const withoutPlaceholders = term.replace(/[<[][^>\]]*[>\]]/g, '')
    return withoutPlaceholders.match(/--?[a-zA-Z][\w-]*/g) ?? []
  })
}

/** Replace semantic version numbers so the golden survives a version bump. */
function normalizeVersions(text: string): string {
  return text.replace(/\d+\.\d+\.\d+/g, 'X.Y.Z')
}

const ROOT_COMMANDS = [
  'agents',
  'auth',
  'autonomy',
  'doctor',
  'import',
  'mcp',
  'migrate',
  'plugin|plugins',
  'project',
  'setup-token',
  'update',
]

const ROOT_OPTIONS = [
  '--add-dir',
  '--agent',
  '--agents',
  '--allow-dangerously-skip-permissions',
  '--allowedTools',
  '--allowed-tools',
  '--append-system-prompt',
  '--autocompact',
  '--ax-screen-reader',
  '--bare',
  '--betas',
  '-c',
  '--continue',
  '--dangerously-skip-permissions',
  '-d',
  '--debug',
  '--debug-file',
  '--disable-slash-commands',
  '--disallowedTools',
  '--disallowed-tools',
  '--effort',
  '--fallback-model',
  '--file',
  '--fork-session',
  '--forward-subagent-text',
  '--from-pr',
  '-h',
  '--help',
  '--ide',
  '--include-hook-events',
  '--include-partial-messages',
  '--input-format',
  '--json-schema',
  '--max-budget-usd',
  '--mcp-config',
  '--mcp-debug',
  '--model',
  '-n',
  '--name',
  '--no-session-persistence',
  '--output-format',
  '--permission-mode',
  '--plugin-dir',
  '--plugin-url',
  '-p',
  '--print',
  '--replay-user-messages',
  '-r',
  '--resume',
  '--safe-mode',
  '--session-id',
  '--setting-sources',
  '--settings',
  '--strict-mcp-config',
  '--system-prompt',
  '--tmux',
  '--tools',
  '--verbose',
  '-v',
  '--version',
  '-w',
  '--worktree',
]

beforeAll(async () => {
  const queue = Object.keys(INVOCATIONS)
  const workers = Array.from({ length: SPAWN_CONCURRENCY }, async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const invocation = INVOCATIONS[name] as (typeof INVOCATIONS)[string]
      recorded.set(name, await runCli(invocation.args, invocation.env ?? {}))
    }
  })
  await Promise.all(workers)
}, BATCH_TIMEOUT_MS)

afterAll(() => {
  rmSync(configDir, { force: true, recursive: true })
})

describe('occ --help', () => {
  test(
    'exits cleanly with the documented usage line',
    () => {
      const result = golden('root-help')
      expect(result.exitCode).toBe(0)
      expect(result.stderr.trim()).toBe('')
      expect(result.stdout.split('\n')[0]).toBe(
        'Usage: occ [options] [command] [prompt]',
      )
      expect(result.stdout).toContain(
        'Open Claude Code - starts an interactive session by default',
      )
    },
    ASSERT_TIMEOUT_MS,
  )

  test(
    'lists exactly the non-feature-gated top-level commands',
    () => {
      // Feature flags are all off in this child process, so the gated
      // commands (auto-mode, remote-control, ssh, kairos, …) and the
      // USER_TYPE=ant commands are deliberately absent.
      expect(commandNames(golden('root-help').stdout)).toEqual(ROOT_COMMANDS)
    },
    ASSERT_TIMEOUT_MS,
  )

  test(
    'lists exactly the documented root option flags',
    () => {
      expect(optionFlags(golden('root-help').stdout)).toEqual(ROOT_OPTIONS)
    },
    ASSERT_TIMEOUT_MS,
  )

  test(
    'does not surface options that are explicitly hidden from help',
    () => {
      const flags = optionFlags(golden('root-help').stdout)
      for (const hidden of ['--init', '--init-only', '--maintenance']) {
        expect(flags).not.toContain(hidden)
      }
    },
    ASSERT_TIMEOUT_MS,
  )
})

describe('occ --version', () => {
  test(
    'prints the version and product name on the zero-import fast path',
    () => {
      const result = golden('version')
      expect(result.exitCode).toBe(0)
      expect(result.stderr.trim()).toBe('')
      expect(normalizeVersions(result.stdout.trim())).toBe(
        'X.Y.Z (Open Claude Code)',
      )
    },
    ASSERT_TIMEOUT_MS,
  )
})

describe('occ <subcommand> --help', () => {
  const cases: Array<{
    commands: string[]
    name: keyof typeof INVOCATIONS
    usage: string
  }> = [
    {
      name: 'mcp-help',
      usage: 'Usage: occ mcp [options] [command]',
      commands: [
        'add',
        'add-from-claude-desktop',
        'add-json',
        'get',
        'help',
        'list',
        'login',
        'logout',
        'remove',
        'reset-project-choices',
        'serve',
      ],
    },
    {
      name: 'auth-help',
      usage: 'Usage: occ auth [options] [command]',
      commands: ['help', 'login', 'logout', 'status'],
    },
    {
      name: 'plugin-help',
      usage: 'Usage: occ plugin|plugins [options] [command]',
      commands: [
        'details',
        'disable',
        'enable',
        'eval',
        'help',
        'install|i',
        'list',
        'marketplace',
        'uninstall|remove',
        'update',
        'validate',
      ],
    },
    {
      name: 'doctor-help',
      usage: 'Usage: occ doctor [options]',
      commands: [],
    },
    {
      name: 'update-help',
      usage: 'Usage: occ update [options]',
      commands: [],
    },
  ]

  for (const testCase of cases) {
    test(
      `${testCase.name} prints its usage line and subcommands`,
      () => {
        const result = golden(testCase.name)
        expect(result.exitCode).toBe(0)
        expect(result.stderr.trim()).toBe('')
        expect(result.stdout.split('\n')[0]).toBe(testCase.usage)
        expect(commandNames(result.stdout)).toEqual(testCase.commands)
        expect(optionFlags(result.stdout)).toEqual(['-h', '--help'])
      },
      ASSERT_TIMEOUT_MS,
    )
  }

  test(
    'plugin eval pins its ablation, ceiling and dry-run surface',
    () => {
      // `plugin eval` spends real money per invocation, so the flags that
      // bound it are part of its contract, not decoration: --dry-run must stay
      // reachable, and --max-cost-usd / --max-duration / --timeout must all
      // remain present. --ablation is pinned because the with/without
      // comparison is the whole point of the command.
      const result = golden('plugin-eval-help')
      expect(result.exitCode).toBe(0)
      expect(result.stderr.trim()).toBe('')
      expect(result.stdout.split('\n')[0]).toBe(
        'Usage: occ plugin eval [options] [command] [target]',
      )
      expect(commandNames(result.stdout)).toEqual(['init'])
      expect(optionFlags(result.stdout)).toEqual([
        '--ablation',
        '--allow-assert-commands',
        '--allow-tools',
        '--case',
        '--dry-run',
        '--fail-on-regression',
        '-h',
        '--help',
        '--json',
        '--judge-model',
        '--keep-temp',
        '--max-cost-usd',
        '--max-duration',
        '--model',
        '--publish',
        '--report',
        '--runs',
        '--tag',
        '--threshold',
        '--timeout',
      ])
    },
    ASSERT_TIMEOUT_MS,
  )

  test(
    'agents exposes the --list escape hatch alongside the interactive list',
    () => {
      // `occ agents` with no flags on a TTY mounts FleetView; `--list` keeps
      // the original "print configured agent definitions" behaviour, and a
      // non-TTY invocation (this one, and CI) falls back to it on its own.
      // The flag is what makes the semantic change reversible, so it is pinned
      // here rather than left to the description text.
      const result = golden('agents-help')
      expect(result.exitCode).toBe(0)
      expect(result.stderr.trim()).toBe('')
      expect(result.stdout.split('\n')[0]).toBe('Usage: occ agents [options]')
      expect(commandNames(result.stdout)).toEqual([])
      expect(optionFlags(result.stdout)).toEqual([
        '--all',
        '--cwd',
        '-h',
        '--help',
        '--json',
        '--list',
        '--setting-sources',
      ])
    },
    ASSERT_TIMEOUT_MS,
  )

  test(
    'task is registered only when USER_TYPE=ant',
    () => {
      const result = golden('task-help')
      expect(result.exitCode).toBe(0)
      expect(result.stdout.split('\n')[0]).toBe(
        'Usage: occ task [options] [command]',
      )
      expect(result.stdout).toContain('[ANT-ONLY]')
      expect(commandNames(result.stdout)).toEqual([
        'create',
        'dir',
        'get',
        'help',
        'list',
        'update',
      ])
      // The same command is absent from the default surface.
      expect(commandNames(golden('root-help').stdout)).not.toContain('task')
    },
    ASSERT_TIMEOUT_MS,
  )

  test(
    'autonomy is intercepted before Commander and prints slash-command usage',
    () => {
      // `src/entrypoints/cli.tsx` fast-paths `autonomy` so state inspection
      // skips the interactive bootstrap. The consequence is that `--help` is
      // parsed by the autonomy arg parser, not by Commander: it yields the
      // /autonomy usage string and exit code 0.
      const result = golden('autonomy-help')
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe(
        'Usage: /autonomy [status [--deep]|runs [limit]|flows [limit]|flow <id>|flow cancel <id>|flow resume <id>]',
      )
      expect(result.stdout).not.toContain('Usage: occ autonomy')
    },
    ASSERT_TIMEOUT_MS,
  )
})

describe('occ argument validation', () => {
  test(
    'rejects an unknown flag with a non-zero exit and names the flag',
    () => {
      const result = golden('unknown-flag')
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('unknown option')
      expect(result.stderr).toContain('--definitely-not-a-real-flag')
    },
    ASSERT_TIMEOUT_MS,
  )

  test(
    'rejects an invalid --output-format choice before doing any work',
    () => {
      // -p short-circuits main.tsx into parsing immediately, so this must
      // fail inside Commander — no auth, no MCP startup, no API request.
      const result = golden('bogus-output-format')
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr.trim()).toBe(
        "error: option '--output-format <format>' argument 'bogus' is invalid. Allowed choices are text, json, stream-json.",
      )
      // Proxies for "never reached the network / credential layer".
      expect(result.stderr).not.toContain('anthropic')
      expect(result.stderr).not.toContain('API key')
    },
    ASSERT_TIMEOUT_MS,
  )

  test(
    'accepts --effort xhigh',
    () => {
      // xhigh is the factory effort default for most provider families, and a
      // hand-copied allowlist in rootOptions.tsx used to reject it while every
      // other surface (settings, /model, the provider wizard) accepted it.
      // The run still fails — on the deliberately bogus companion flag, which
      // is what proves --effort itself parsed.
      const result = golden('effort-xhigh')
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('unknown option')
      expect(result.stderr).not.toContain('It must be one of')
    },
    ASSERT_TIMEOUT_MS,
  )

  test(
    'still rejects an effort level that is not in EFFORT_LEVELS',
    () => {
      const result = golden('effort-bogus')
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('It must be one of')
      expect(result.stderr).toContain('xhigh')
    },
    ASSERT_TIMEOUT_MS,
  )

  test(
    'accepts --permission-mode manual (upstream alias for default)',
    () => {
      // A settings.json / command line copied from an official install must
      // not bounce off occ.
      const result = golden('permission-mode-manual')
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('unknown option')
      expect(result.stderr).not.toContain('Allowed choices are')
    },
    ASSERT_TIMEOUT_MS,
  )
})

/**
 * `occ migrate` is intercepted by a fast path in cli.tsx that runs the
 * migration for real, before commander ever sees the args. `--help` must fall
 * through to commander: a user asking what the command does should not have
 * files copied into their config dir as a side effect of asking.
 */
/**
 * `requiredMinimumVersion` / `requiredMaximumVersion` from managed (policy)
 * settings. Exercised through a real subprocess because the gate lives in the
 * Commander `preAction` hook — the thing being asserted is *when* it runs, and
 * an in-process test of the pure comparison (see
 * `src/utils/settings/__tests__/versionGate.test.ts`) cannot show that.
 */
describe('managed version gate', () => {
  async function runWithPolicy(
    policy: Record<string, unknown>,
    args: string[],
  ): Promise<CliResult> {
    const policyDir = mkdtempSync(join(tmpdir(), 'occ-policy-'))
    const ownConfigDir = mkdtempSync(join(tmpdir(), 'occ-policy-cfg-'))
    writeFileSync(
      join(policyDir, 'managed-settings.json'),
      JSON.stringify(policy),
    )
    try {
      return await runCli(args, {
        OCC_MANAGED_SETTINGS_PATH: policyDir,
        OCC_CONFIG_DIR: ownConfigDir,
        CLAUDE_CONFIG_DIR: ownConfigDir,
      })
    } finally {
      rmSync(policyDir, { force: true, recursive: true })
      rmSync(ownConfigDir, { force: true, recursive: true })
    }
  }

  test('refuses to run a command when the build is below the minimum', async () => {
    const result = await runWithPolicy({ requiredMinimumVersion: '99.0.0' }, [
      'mcp',
      'list',
    ])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('require at least 99.0.0')
    expect(result.stdout).not.toContain('MCP servers')
  }, 120_000)

  test('refuses to run a command when the build is above the maximum', async () => {
    const result = await runWithPolicy({ requiredMaximumVersion: '0.1.0' }, [
      'mcp',
      'list',
    ])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('allow at most 0.1.0')
  }, 120_000)

  test('--help is never gated', async () => {
    // An admin pinning a version range must not stop the user from reading the
    // help text; Commander does not run preAction for --help, and this pins it.
    const result = await runWithPolicy({ requiredMinimumVersion: '99.0.0' }, [
      'mcp',
      '--help',
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Usage: occ mcp')
  }, 120_000)

  test('an unparseable policy value fails open', async () => {
    // A typo in a policy file must not lock a whole fleet out of its tooling.
    const result = await runWithPolicy({ requiredMinimumVersion: 'latest' }, [
      'mcp',
      'list',
    ])
    expect(result.stderr).not.toContain('managed settings')
    expect(result.exitCode).toBe(0)
  }, 120_000)
})

/**
 * Startup must survive the environments that have no Anthropic credential.
 *
 * `getAnthropicApiKeyWithSource()` throws under `NODE_ENV=test` / `CI` when
 * neither `ANTHROPIC_API_KEY` nor an OAuth token is set. `isAnthropicAuthEnabled()`
 * calls it, `getOauthAccountInfo()` calls that, and `init()` awaits it through
 * `initUser()` — so the throw escaped the Commander `preAction` hook and left
 * the process alive, idle, and silent until something SIGKILLed it. `occ mcp
 * list` printed nothing and never exited on any CI runner without a key.
 *
 * Every `--help` / `--version` / parse-error invocation above stops before
 * `preAction` and cannot see this, which is exactly why it went unnoticed;
 * these two runs reach it.
 */
describe('boots under NODE_ENV=test / CI without a credential', () => {
  // Generous but far below a hang: the failure mode is "never exits", and
  // runCli's watchdog SIGKILLs at SPAWN_TIMEOUT_MS, surfacing exitCode null.
  const BOOT_TIMEOUT_MS = 120_000

  test(
    'NODE_ENV=test reaches a preAction command and exits cleanly',
    async () => {
      const result = await runCli(['mcp', 'list'], { NODE_ENV: 'test' })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('No MCP servers configured')
    },
    BOOT_TIMEOUT_MS,
  )

  test(
    'CI=1 reaches a preAction command and exits cleanly',
    async () => {
      // The production-facing half of the same branch: no NODE_ENV involved,
      // just a CI runner with no key.
      const result = await runCli(['mcp', 'list'], { CI: '1', NODE_ENV: '' })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('No MCP servers configured')
    },
    BOOT_TIMEOUT_MS,
  )
})

describe('migrate --help does not perform a migration', () => {
  test('prints help and leaves the config dir untouched', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'occ-migrate-help-'))
    const legacyDir = mkdtempSync(join(tmpdir(), 'claude-migrate-help-'))
    // A legacy setup with something migratable, so a real run would be visible.
    mkdirSync(join(legacyDir, 'agents'), { recursive: true })
    writeFileSync(join(legacyDir, 'settings.json'), '{"theme":"dark"}')

    try {
      const result = await runCli(['migrate', '--help'], {
        OCC_CONFIG_DIR: configDir,
        CLAUDE_CONFIG_DIR: legacyDir,
      })

      expect(result.stdout).toContain('--skip-account-data')
      expect(result.stdout).not.toContain('Would copy')
      // The marker is what a real run writes; its absence proves nothing ran.
      expect(existsSync(join(configDir, '.migrated'))).toBe(false)
      expect(existsSync(join(configDir, 'agents'))).toBe(false)
    } finally {
      rmSync(configDir, { force: true, recursive: true })
      rmSync(legacyDir, { force: true, recursive: true })
    }
  })
})

describe('subagent / plan-mode CLI options', () => {
  test(
    '--forward-subagent-text without stream-json hits its rootAction guard',
    () => {
      const result = golden('forward-subagent-text-without-stream-json')
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain(
        'Error: --forward-subagent-text requires --print and --output-format=stream-json.',
      )
      // The guard fires before anything reaches auth or the network.
      expect(result.stderr).not.toContain('API key')
    },
    ASSERT_TIMEOUT_MS,
  )

  const accepted = [
    {
      name: 'forward-subagent-text-accepted' as const,
      notRejectedWith: '--forward-subagent-text requires',
    },
    {
      name: 'plan-mode-instructions-accepted' as const,
      notRejectedWith: '--plan-mode-instructions',
    },
    {
      name: 'append-subagent-system-prompt-accepted' as const,
      notRejectedWith: '--append-subagent-system-prompt',
    },
  ]

  for (const testCase of accepted) {
    test(
      `${testCase.name} parses the option and its argument`,
      () => {
        const result = golden(testCase.name)
        expect(result.exitCode).not.toBe(0)
        // Failing on the companion bogus flag, not on the option under test.
        expect(result.stderr).toContain('unknown option')
        expect(result.stderr).toContain('--definitely-not-a-real-flag')
        expect(result.stderr).not.toContain(testCase.notRejectedWith)
      },
      ASSERT_TIMEOUT_MS,
    )
  }
})
