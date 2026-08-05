/**
 * Characterization snapshots for the four heaviest tool prompts.
 *
 * These prompts feed the API prompt cache: any byte that changes busts the
 * cached tools block for every session on the fleet. The leaf-extraction
 * refactor (moving env/settings/feature/sandbox reads out of `prompt.ts` and
 * into the tool's `prompt()` method) must therefore be output-preserving, and
 * these snapshots are the proof.
 *
 * Run via the thin spawner in `promptCharacterization.test.ts` — never
 * directly in the main suite. Two reasons:
 *
 *   1. Importing BashTool pulls ~15s worth of module graph (SandboxManager,
 *      auth, analytics, the API client). One subprocess amortises that across
 *      every scenario instead of paying it per test file.
 *   2. The SandboxManager monkey-patches below are process-global. A dedicated
 *      process keeps them from leaking into the rest of the suite.
 *
 * Scenario knobs, and why each one is shaped the way it is:
 *
 *   env          read fresh on every prompt() call, so scenarios can just
 *                mutate process.env between renders.
 *   sandbox      `SandboxManager` is a plain exported object, so its methods
 *                can be swapped per scenario without replacing the module.
 *
 * Not reachable from here, and therefore covered by review plus direct unit
 * tests of the extracted pure renderers instead:
 *
 *   - `feature()` from `bun:bundle` is a compile-time macro. It is `false` for
 *     every flag under `bun test` and `mock.module('bun:bundle')` does not
 *     change that, so MONITOR_TOOL / COORDINATOR_MODE / FORK_SUBAGENT branches
 *     cannot be snapshotted. Those checks move verbatim into the tool methods.
 *   - `isCompactLinePrefixEnabled()` / `getDefaultFileReadingLimits()` read
 *     GrowthBook. The only env override (CLAUDE_INTERNAL_FC_OVERRIDES) is
 *     parsed once per process and is ant-gated, and the limits getter is
 *     lodash-memoized, so neither can vary within a single process.
 */
import { beforeAll, describe, expect, test } from 'bun:test'

const { BashTool } = await import('../BashTool/BashTool.js')
const { AgentTool } = await import('../AgentTool/AgentTool.js')
const { FileReadTool } = await import('../FileReadTool/FileReadTool.js')
const { FileEditTool } = await import('../FileEditTool/FileEditTool.js')
const { SandboxManager } = await import('src/utils/sandbox/sandbox-adapter.js')
const { getClaudeTempDir } = await import('src/utils/permissions/filesystem.js')

/**
 * Every environment variable any of the four prompts reads. Cleared before
 * each scenario so a developer's shell can't leak into a snapshot.
 */
const PROMPT_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  // The GPT tuning gate (restrained AgentTool copy) keys off the resolved
  // provider. The isolated config dir hides a settings-based `modelType`, but
  // a developer shell exporting these would still flip it.
  'CLAUDE_CODE_USE_OPENAI',
  'OPENAI_MODEL',
  'CLAUDE_CODE_AGENT_LIST_IN_MESSAGES',
  'CLAUDE_CODE_COORDINATOR_MODE',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_UNDERCOVER',
  'EMBEDDED_SEARCH_TOOLS',
  'USER_TYPE',
] as const

function resetEnv(): void {
  for (const key of PROMPT_ENV_KEYS) delete process.env[key]
}

function applyEnv(env: Record<string, string>): void {
  resetEnv()
  for (const [key, value] of Object.entries(env)) process.env[key] = value
}

type SandboxOverrides = Partial<typeof SandboxManager>

const pristineSandbox = new Map<string, unknown>()

function applySandbox(overrides: SandboxOverrides): void {
  const target = SandboxManager as unknown as Record<string, unknown>
  // Restore anything a previous scenario replaced, then install the new set.
  for (const [key, value] of pristineSandbox) target[key] = value
  pristineSandbox.clear()
  for (const [key, value] of Object.entries(overrides)) {
    pristineSandbox.set(key, target[key])
    target[key] = value
  }
}

beforeAll(() => {
  resetEnv()
})

// ---------------------------------------------------------------------------
// BashTool
// ---------------------------------------------------------------------------

/**
 * A sandbox config with the shapes the prompt actually reads: duplicate paths
 * (the prompt dedups them), the per-UID temp dir (the prompt rewrites it to
 * $TMPDIR), plus network and violation config.
 */
function sandboxEnabled(allowUnsandboxedCommands: boolean): SandboxOverrides {
  return {
    isSandboxingEnabled: () => true,
    getFsReadConfig: () => ({
      denyOnly: ['/etc/shadow', '/etc/shadow', '~/.ssh'],
      allowWithinDeny: ['~/.ssh/known_hosts', '~/.ssh/known_hosts'],
    }),
    getFsWriteConfig: () => ({
      allowOnly: ['/workspace', '/workspace', getClaudeTempDir()],
      denyWithinAllow: ['/workspace/.git', '/workspace/.git'],
    }),
    getNetworkRestrictionConfig: () => ({
      allowedHosts: ['registry.npmjs.org', 'registry.npmjs.org'],
      deniedHosts: ['evil.example'],
    }),
    getAllowUnixSockets: () => ['/var/run/docker.sock', '/var/run/docker.sock'],
    getIgnoreViolations: () => ({ read: ['/proc/self/mem'] }),
    areUnsandboxedCommandsAllowed: () => allowUnsandboxedCommands,
  }
}

const BASH_SCENARIOS: Array<{
  name: string
  env: Record<string, string>
  sandbox: SandboxOverrides
}> = [
  // External user, everything at its default. The most-shipped configuration.
  { name: 'default', env: {}, sandbox: {} },
  // Ant user: short git section pointing at skills, plus undercover preamble.
  {
    name: 'ant-undercover',
    env: { USER_TYPE: 'ant', CLAUDE_CODE_UNDERCOVER: '1' },
    sandbox: {},
  },
  // CLAUDE_CODE_SIMPLE drops the skills block; background tasks disabled drops
  // the run_in_background note.
  {
    name: 'ant-simple-no-background',
    env: {
      USER_TYPE: 'ant',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    },
    sandbox: {},
  },
  // Ant-native build: find/grep aliased to bfs/ugrep, Glob/Grep tools gone,
  // git instructions off entirely.
  {
    name: 'embedded-search-no-git',
    env: {
      EMBEDDED_SEARCH_TOOLS: '1',
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
    },
    sandbox: {},
  },
  // Sandbox on, `dangerouslyDisableSandbox` available.
  { name: 'sandbox-overridable', env: {}, sandbox: sandboxEnabled(true) },
  // Sandbox on, overrides forbidden by policy.
  { name: 'sandbox-locked', env: {}, sandbox: sandboxEnabled(false) },
]

describe('BashTool prompt', () => {
  for (const scenario of BASH_SCENARIOS) {
    test(`prompt() — ${scenario.name}`, async () => {
      applyEnv(scenario.env)
      applySandbox(scenario.sandbox)
      expect(await BashTool.prompt?.()).toMatchSnapshot()
      applySandbox({})
    })
  }

  test('description() is the caller-supplied description or a fallback', async () => {
    expect(
      await BashTool.description?.({
        command: 'ls',
        description: 'List files',
      } as never),
    ).toMatchSnapshot()
    expect(
      await BashTool.description?.({ command: 'ls' } as never),
    ).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// AgentTool
// ---------------------------------------------------------------------------

/**
 * Fixed agent set covering every branch of the tool-listing formatter:
 * no restrictions, allowlist only, denylist only, both lists, an agent removed
 * by a deny rule, and an agent gated on an MCP server.
 */
const AGENTS = [
  {
    agentType: 'general-purpose',
    whenToUse: 'General-purpose agent for researching complex questions',
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => '',
  },
  {
    agentType: 'Explore',
    whenToUse: 'Read-only search agent for broad fan-out searches',
    tools: ['Read', 'Glob', 'Grep'],
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => '',
  },
  {
    agentType: 'code-reviewer',
    whenToUse: 'Reviews code for bugs and convention drift',
    disallowedTools: ['Bash', 'Write'],
    source: 'projectSettings',
    getSystemPrompt: () => '',
  },
  {
    agentType: 'doc-writer',
    whenToUse: 'Writes documentation',
    tools: ['Read', 'Write', 'Bash'],
    disallowedTools: ['Bash'],
    source: 'userSettings',
    getSystemPrompt: () => '',
  },
  {
    agentType: 'blocked-agent',
    whenToUse: 'Removed by the Agent(blocked-agent) deny rule',
    source: 'userSettings',
    getSystemPrompt: () => '',
  },
  {
    agentType: 'github-agent',
    whenToUse: 'Needs the github MCP server',
    requiredMcpServers: ['github'],
    source: 'userSettings',
    getSystemPrompt: () => '',
  },
] as never[]

const AGENT_TOOLS = [
  { name: 'Read' },
  { name: 'mcp__github__list_issues' },
] as never[]

function agentPromptParams(allowedAgentTypes?: string[]) {
  return {
    agents: AGENTS,
    tools: AGENT_TOOLS,
    allowedAgentTypes,
    getToolPermissionContext: async () => ({
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: { userSettings: ['Agent(blocked-agent)'] },
      alwaysAskRules: {},
    }),
  } as never
}

const AGENT_SCENARIOS: Array<{
  name: string
  env: Record<string, string>
  allowedAgentTypes?: string[]
}> = [
  // Inline agent list, background agents available, non-pro concurrency note.
  { name: 'default', env: {} },
  // Agent list moves to an attachment; the inline list and concurrency note go.
  {
    name: 'agent-list-in-messages',
    env: { CLAUDE_CODE_AGENT_LIST_IN_MESSAGES: '1' },
  },
  // Ant build: remote isolation note, embedded search hints, no background note.
  {
    name: 'ant-embedded-no-background',
    env: {
      USER_TYPE: 'ant',
      EMBEDDED_SEARCH_TOOLS: '1',
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    },
  },
  // Agent(x,y) restricts which agent types may be listed.
  {
    name: 'allowed-agent-types',
    env: {},
    allowedAgentTypes: ['Explore', 'code-reviewer', 'blocked-agent'],
  },
]

describe('AgentTool prompt', () => {
  for (const scenario of AGENT_SCENARIOS) {
    test(`prompt() — ${scenario.name}`, async () => {
      applyEnv(scenario.env)
      expect(
        await AgentTool.prompt?.(agentPromptParams(scenario.allowedAgentTypes)),
      ).toMatchSnapshot()
    })
  }

  test('description() is static', async () => {
    applyEnv({})
    expect(await AgentTool.description?.()).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// FileReadTool
// ---------------------------------------------------------------------------

const READ_SCENARIOS: Array<{ name: string; env: Record<string, string> }> = [
  // PDF-capable model: the PDF bullet is present.
  { name: 'default', env: {} },
  // Haiku 3 predates PDF document blocks — the PDF bullet drops out.
  {
    name: 'haiku-3-no-pdf',
    env: { ANTHROPIC_MODEL: 'claude-3-haiku-20240307' },
  },
]

describe('FileReadTool prompt', () => {
  for (const scenario of READ_SCENARIOS) {
    test(`prompt() — ${scenario.name}`, async () => {
      applyEnv(scenario.env)
      expect(await FileReadTool.prompt?.()).toMatchSnapshot()
    })
  }

  test('description() is static', async () => {
    applyEnv({})
    expect(await FileReadTool.description?.()).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// FileEditTool
// ---------------------------------------------------------------------------

const EDIT_SCENARIOS: Array<{ name: string; env: Record<string, string> }> = [
  { name: 'default', env: {} },
  // Ant users get the extra "smallest unique old_string" hint.
  { name: 'ant', env: { USER_TYPE: 'ant' } },
]

describe('FileEditTool prompt', () => {
  for (const scenario of EDIT_SCENARIOS) {
    test(`prompt() — ${scenario.name}`, async () => {
      applyEnv(scenario.env)
      expect(await FileEditTool.prompt?.()).toMatchSnapshot()
    })
  }

  test('description() is static', async () => {
    applyEnv({})
    expect(await FileEditTool.description?.()).toMatchSnapshot()
  })
})
