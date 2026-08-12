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
  'autonomy-help': { args: ['autonomy', '--help'] },
  'doctor-help': { args: ['doctor', '--help'] },
  'task-help': { args: ['task', '--help'], env: { USER_TYPE: 'ant' } },
  'update-help': { args: ['update', '--help'] },
  'unknown-flag': { args: ['--definitely-not-a-real-flag'] },
  'bogus-output-format': {
    args: ['-p', '--output-format', 'bogus', 'hello'],
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
        'disable',
        'enable',
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
        '-h',
        '--help',
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
})

/**
 * `occ migrate` is intercepted by a fast path in cli.tsx that runs the
 * migration for real, before commander ever sees the args. `--help` must fall
 * through to commander: a user asking what the command does should not have
 * files copied into their config dir as a side effect of asking.
 */
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
