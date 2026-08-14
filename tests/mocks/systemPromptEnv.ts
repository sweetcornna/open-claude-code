/**
 * The mock chain needed to render a system prompt without a real session.
 *
 * Two callers need it: the guardrail runner
 * (src/constants/promptEngineeringAudit.runner.ts) and scripts/dump-prompt.ts.
 * They used to carry hand-written copies, which drifted — dump-prompt's copy
 * pinned `src/bootstrap/state` to a three-export object and started throwing
 * "Export named 'addSlowOperation' not found" the moment the prompt reached
 * one more state consumer. Whatever the prompt happens to import next, both
 * callers now get the same complete surfaces.
 *
 * Every override here exists to make the output *deterministic*, not to stub
 * something out: the prompt must not vary with the host machine's provider
 * config, git state, feature flags or terminal.
 */

import { mock } from 'bun:test'
import { stateMockWith } from './state.js'
import { setupGrowthbookMock } from './growthbook.js'
import { setupEnvUtilsMock } from './envUtils.js'
import { setupSettingsMock } from './settings.js'

/** Flipped by the boundary-position assertion; the marker only renders when on. */
let globalCacheScope = false

/**
 * Whether this session serves Anthropic checkpoints. Toggleable because the
 * env section's model-catalog line hangs off it, and "an OpenAI session is not
 * told to write `claude-opus-5` into the user's code" is a guarantee worth
 * testing from both sides.
 */
let servesAnthropic = true

export type SystemPromptMockHandle = {
  reset: () => void
  setGlobalCacheScope: (enabled: boolean) => void
  setServesAnthropicModels: (enabled: boolean) => void
}

export function setupSystemPromptMocks(): SystemPromptMockHandle {
  // Build-time defines are not substituted when the module is loaded directly.
  ;(globalThis as unknown as { MACRO: Record<string, string> }).MACRO = {
    VERSION: '2.1.888',
    BUILD_TIME: '2026-04-22T00:00:00Z',
    FEEDBACK_CHANNEL: 'https://github.com/sweetcornna/open-claude-code/issues',
    ISSUES_EXPLAINER:
      'report the issue at https://github.com/sweetcornna/open-claude-code/issues',
    NATIVE_PACKAGE_URL: '',
    PACKAGE_URL: '',
    VERSION_CHANGELOG: '',
  }

  mock.module(
    'src/bootstrap/state.ts',
    stateMockWith({
      getIsNonInteractiveSession: () => false,
      sessionId: 'test-session',
      getCwd: () => '/test/project',
    }),
  )
  mock.module('src/utils/filesystem/cwd.ts', () => ({
    getCwd: () => '/test/project',
  }))
  mock.module('src/utils/git/git.ts', () => ({ getIsGit: async () => true }))
  mock.module('src/utils/git/worktree.ts', () => ({
    getCurrentWorktreeSession: () => null,
  }))
  mock.module('src/constants/common.ts', () => ({
    getSessionStartDate: () => '2026-04-22',
  }))
  mock.module('src/commands/poor/poorMode.ts', () => ({
    isPoorModeActive: () => false,
  }))
  mock.module('src/utils/config/env.ts', () => ({ env: { platform: 'linux' } }))
  mock.module('src/utils/model/model.ts', () => ({
    getCanonicalName: (id: string) => id,
    getMarketingNameForModel: (id: string) => {
      if (id.includes('opus-5')) return 'Opus 5'
      if (id.includes('sonnet-5')) return 'Sonnet 5'
      if (id.includes('fable-5')) return 'Fable 5'
      if (id.includes('opus-4-7')) return 'Claude Opus 4.7'
      if (id.includes('opus-4-6')) return 'Claude Opus 4.6'
      if (id.includes('sonnet-4-6')) return 'Claude Sonnet 4.6'
      return null
    },
  }))
  // Anchors the "which model catalog does this session serve" answer so the
  // env section does not change shape with the host's provider config.
  mock.module('src/utils/model/providers.ts', () => ({
    servesAnthropicModels: () => servesAnthropic,
    isThirdPartyModelCatalog: () => !servesAnthropic,
    getAPIProvider: () => (servesAnthropic ? 'firstParty' : 'openai'),
  }))
  mock.module('src/utils/model/fastMode.ts', () => ({
    isFastModeAvailable: () => servesAnthropic,
    isFastModeEnabled: () => true,
  }))
  mock.module('src/commands.ts', () => ({
    getSkillToolCommands: async () => [],
  }))
  mock.module('src/constants/outputStyles.ts', () => ({
    getOutputStyleConfig: async () => null,
  }))
  mock.module('src/utils/tools/embeddedTools.ts', () => ({
    hasEmbeddedSearchTools: () => false,
  }))
  mock.module('src/utils/permissions/filesystem.ts', () => ({
    isScratchpadEnabled: () => false,
    getScratchpadDir: () => '/tmp/scratchpad',
  }))
  mock.module('src/utils/model/betas.ts', () => ({
    shouldUseGlobalCacheScope: () => globalCacheScope,
  }))
  mock.module('src/utils/mcp/mcpInstructionsDelta.ts', () => ({
    isMcpInstructionsDeltaEnabled: () => false,
  }))
  mock.module('src/memdir/memdir.ts', () => ({
    loadMemoryPrompt: async () => null,
  }))
  mock.module('src/utils/telemetry/debug.ts', () => ({
    logForDebugging: () => {},
  }))
  mock.module('bun:bundle', () => ({ feature: (_name: string) => false }))
  // Sections resolve eagerly so a dump reflects the current code, not a cache.
  mock.module('src/constants/systemPromptSections.ts', () => ({
    systemPromptSection: (_name: string, fn: () => unknown) => fn(),
    DANGEROUS_uncachedSystemPromptSection: (_name: string, fn: () => unknown) =>
      fn(),
    // Await before filtering: half the sections are async, and returning the
    // unresolved promises renders them as the literal "[object Promise]".
    resolveSystemPromptSections: async (sections: unknown[]) =>
      (await Promise.all(sections)).filter(s => s !== null),
  }))

  for (const [specifier, exports] of Object.entries(TOOL_NAME_MODULES)) {
    mock.module(specifier, () => exports)
  }

  const settingsMock = setupSettingsMock({
    getInitialSettings: () => ({ language: undefined }),
  })
  // Pinned false: the prompt must be deterministic regardless of whatever env
  // flags the host machine happens to have set.
  const envUtilsMock = setupEnvUtilsMock({ isEnvTruthy: () => false })
  const growthbookMock = setupGrowthbookMock({
    getFeatureValue_CACHED_MAY_BE_STALE: () => false,
  })

  return {
    reset: () => {
      settingsMock.reset()
      envUtilsMock.reset()
      growthbookMock.reset()
    },
    setGlobalCacheScope: (enabled: boolean) => {
      globalCacheScope = enabled
    },
    setServesAnthropicModels: (enabled: boolean) => {
      servesAnthropic = enabled
    },
  }
}

/**
 * Tool names the prompt interpolates. Mocked so loading the prompt does not
 * drag in the tool implementations (and their MCP/network dependencies).
 */
const TOOL_NAME_MODULES: Record<string, Record<string, unknown>> = {
  '@open-claude-code/builtin-tools/tools/BashTool/toolName.js': {
    BASH_TOOL_NAME: 'Bash',
  },
  '@open-claude-code/builtin-tools/tools/PowerShellTool/toolName.js': {
    POWERSHELL_TOOL_NAME: 'PowerShell',
  },
  '@open-claude-code/builtin-tools/tools/FileReadTool/prompt.js': {
    FILE_READ_TOOL_NAME: 'Read',
  },
  '@open-claude-code/builtin-tools/tools/FileEditTool/constants.js': {
    FILE_EDIT_TOOL_NAME: 'Edit',
  },
  '@open-claude-code/builtin-tools/tools/FileWriteTool/prompt.js': {
    FILE_WRITE_TOOL_NAME: 'Write',
  },
  '@open-claude-code/builtin-tools/tools/GlobTool/prompt.js': {
    GLOB_TOOL_NAME: 'Glob',
  },
  '@open-claude-code/builtin-tools/tools/GrepTool/prompt.js': {
    GREP_TOOL_NAME: 'Grep',
  },
  '@open-claude-code/builtin-tools/tools/AgentTool/constants.js': {
    AGENT_TOOL_NAME: 'Agent',
    VERIFICATION_AGENT_TYPE: 'verification',
  },
  '@open-claude-code/builtin-tools/tools/AgentTool/forkSubagent.js': {
    isForkSubagentEnabled: () => false,
  },
  '@open-claude-code/builtin-tools/tools/AgentTool/builtInAgents.js': {
    areExplorePlanAgentsEnabled: () => false,
  },
  '@open-claude-code/builtin-tools/tools/AgentTool/built-in/exploreAgent.js': {
    EXPLORE_AGENT: { agentType: 'explore' },
    EXPLORE_AGENT_MIN_QUERIES: 5,
  },
  '@open-claude-code/builtin-tools/tools/AskUserQuestionTool/prompt.js': {
    ASK_USER_QUESTION_TOOL_NAME: 'AskUserQuestion',
  },
  '@open-claude-code/builtin-tools/tools/TodoWriteTool/constants.js': {
    TODO_WRITE_TOOL_NAME: 'TodoWrite',
  },
  '@open-claude-code/builtin-tools/tools/TaskCreateTool/constants.js': {
    TASK_CREATE_TOOL_NAME: 'TaskCreate',
  },
  '@open-claude-code/builtin-tools/tools/DiscoverSkillsTool/prompt.js': {
    DISCOVER_SKILLS_TOOL_NAME: 'DiscoverSkills',
  },
  '@open-claude-code/builtin-tools/tools/SkillTool/constants.js': {
    SKILL_TOOL_NAME: 'Skill',
  },
  '@open-claude-code/builtin-tools/tools/REPLTool/replMode.js': {
    isReplModeEnabled: () => false,
  },
  '@open-claude-code/builtin-tools/tools/MonitorTool/constants.js': {
    MONITOR_TOOL_NAME: 'Monitor',
  },
}

/** Standard tool set for a rendered prompt: what a normal session enables. */
export const SYSTEM_PROMPT_MOCK_TOOLS = [
  { name: 'Bash' },
  { name: 'Read' },
  { name: 'Edit' },
  { name: 'Write' },
  { name: 'Glob' },
  { name: 'Grep' },
  { name: 'Agent' },
  { name: 'AskUserQuestion' },
  { name: 'TaskCreate' },
]
