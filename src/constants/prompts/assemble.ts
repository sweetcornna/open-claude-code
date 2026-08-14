import { feature } from 'bun:bundle'
import type { Tools } from '../../Tool.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { getCwd } from '../../utils/filesystem/cwd.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { isEnvTruthy } from '../../utils/config/envUtils.js'
import { shouldUseGlobalCacheScope } from '../../utils/model/betas.js'
import { isMcpInstructionsDeltaEnabled } from '../../utils/mcp/mcpInstructionsDelta.js'
import { logForDebugging } from '../../utils/telemetry/debug.js'
import { loadMemoryPrompt } from '../../memdir/memdir.js'
import { getSkillToolCommands } from 'src/commands.js'
import { getSessionStartDate } from '../common.js'
import { getOutputStyleConfig } from '../outputStyles.js'
import {
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  resolveSystemPromptSections,
} from '../systemPromptSections.js'
import {
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  SUMMARIZE_TOOL_RESULTS_SECTION,
} from './shared.js'
import { getIntroSection } from './intro.js'
import { getSystemSection } from './harness.js'
import { getDoingTasksSection } from './doingTasks.js'
import { getActionsSection } from './actions.js'
import { getUsingYourToolsSection } from './tools.js'
import { getCommunicationSection } from './communication.js'
import {
  getPronounsSection,
  getTaskContinuitySection,
  getDeliveringWorkSection,
  getCorrectionsSection,
  getContextManagementSection,
  getActNotRederiveSection,
} from './conduct.js'
import { getSessionSpecificGuidanceSection } from './sessionGuidance.js'
import { computeSimpleEnvInfo } from './environment.js'
import { getLanguageSection, getOutputStyleSection } from './preferences.js'
import { getMcpInstructionsSection } from './mcp.js'
import { getScratchpadInstructions } from './scratchpad.js'
import {
  isProactiveActive,
  getProactiveSection,
  getBriefSection,
  getSystemRemindersSection,
  PROACTIVE_INTRO,
} from './proactive.js'
import { CYBER_RISK_INSTRUCTION } from '../cyberRiskInstruction.js'

/**
 * Assembles the system prompt as an ordered array of blocks.
 *
 * Two invariants govern the ordering, and both are easy to break silently:
 *
 * 1. Everything before SYSTEM_PROMPT_DYNAMIC_BOUNDARY must be a pure constant
 *    of the build — that prefix is hashed and cached across organizations. A
 *    section whose text varies with a runtime bit belongs after the marker,
 *    or it multiplies the cache-key variants by 2^N.
 * 2. Sections after the marker go through the section registry so they are
 *    memoized per conversation and invalidated on /clear and /compact.
 *
 * Upstream keeps the conduct sections (pronouns, delivering work, corrections,
 * context management) in the dynamic half because their gates read Anthropic
 * A/B flags and Claude model families. occ applies them to every provider
 * unconditionally, which makes them constants — so they sit in the cacheable
 * half here. That is a deliberate divergence, not an oversight.
 */
export async function getSystemPrompt(
  tools: Tools,
  model: string,
  additionalWorkingDirectories?: string[],
  mcpClients?: MCPServerConnection[],
): Promise<string[]> {
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return [
      `You are Claude Code, Anthropic's official CLI for Claude.\n\nCWD: ${getCwd()}\nDate: ${getSessionStartDate()}`,
    ]
  }

  const cwd = getCwd()
  const [skillToolCommands, outputStyleConfig, envInfo] = await Promise.all([
    getSkillToolCommands(cwd),
    getOutputStyleConfig(),
    computeSimpleEnvInfo(model, additionalWorkingDirectories),
  ])

  const settings = getInitialSettings()
  const enabledTools = new Set(tools.map(_ => _.name))

  if (isProactiveActive()) {
    logForDebugging(`[SystemPrompt] path=simple-proactive`)
    return [
      `${PROACTIVE_INTRO}\n\n${CYBER_RISK_INSTRUCTION}`,
      getSystemRemindersSection(),
      getContextManagementSection(),
      await loadMemoryPrompt(),
      envInfo,
      getLanguageSection(settings.language),
      // When delta enabled, instructions are announced via persisted
      // mcp_instructions_delta attachments (attachments.ts) instead.
      isMcpInstructionsDeltaEnabled()
        ? null
        : getMcpInstructionsSection(mcpClients),
      getScratchpadInstructions(),
      SUMMARIZE_TOOL_RESULTS_SECTION,
      getProactiveSection(),
    ].filter(s => s !== null)
  }

  const dynamicSections = [
    systemPromptSection('session_guidance', () =>
      getSessionSpecificGuidanceSection(enabledTools, skillToolCommands),
    ),
    systemPromptSection('memory', () => loadMemoryPrompt()),
    systemPromptSection('env_info_simple', () =>
      computeSimpleEnvInfo(model, additionalWorkingDirectories),
    ),
    systemPromptSection('language', () =>
      getLanguageSection(settings.language),
    ),
    systemPromptSection('output_style', () =>
      getOutputStyleSection(outputStyleConfig),
    ),
    // When delta enabled, instructions are announced via persisted
    // mcp_instructions_delta attachments (attachments.ts) instead of this
    // per-turn recompute, which busts the prompt cache on late MCP connect.
    // Gate check inside compute (not selecting between section variants)
    // so a mid-session gate flip doesn't read a stale cached value.
    DANGEROUS_uncachedSystemPromptSection(
      'mcp_instructions',
      () =>
        isMcpInstructionsDeltaEnabled()
          ? null
          : getMcpInstructionsSection(mcpClients),
      'MCP servers connect/disconnect between turns',
    ),
    systemPromptSection('scratchpad', () => getScratchpadInstructions()),
    ...(feature('TOKEN_BUDGET')
      ? [
          // Cached unconditionally — the "When the user specifies..." phrasing
          // makes it a no-op with no budget active. Was DANGEROUS_uncached
          // (toggled on getCurrentTurnTokenBudget()), busting ~20K tokens per
          // budget flip. Not moved to a tail attachment: first-response and
          // budget-continuation paths don't see attachments.
          systemPromptSection('token_budget', () => TOKEN_BUDGET_SECTION),
        ]
      : []),
    ...(feature('KAIROS') || feature('KAIROS_BRIEF')
      ? [systemPromptSection('brief', () => getBriefSection())]
      : []),
  ]

  const resolvedDynamicSections =
    await resolveSystemPromptSections(dynamicSections)

  const keepCodingInstructions =
    outputStyleConfig === null ||
    outputStyleConfig.keepCodingInstructions === true

  return [
    // --- Static content (cacheable) ---
    getIntroSection(outputStyleConfig),
    getSystemSection(),
    getPronounsSection(),
    keepCodingInstructions ? getDoingTasksSection() : null,
    getActionsSection(),
    getTaskContinuitySection(),
    getUsingYourToolsSection(enabledTools),
    getCommunicationSection(),
    getDeliveringWorkSection(),
    getCorrectionsSection(),
    getContextManagementSection(),
    getActNotRederiveSection(),
    SUMMARIZE_TOOL_RESULTS_SECTION,
    // === BOUNDARY MARKER - DO NOT MOVE OR REMOVE ===
    ...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
    // --- Dynamic content (registry-managed) ---
    ...resolvedDynamicSections,
  ].filter(s => s !== null)
}

const TOKEN_BUDGET_SECTION = `When the user specifies a token target (e.g., "+500k", "spend 2M tokens", "use 1B tokens"), your output token count will be shown each turn. Keep working until you approach the target — plan your work to fill it productively. The target is a hard minimum, not a suggestion. If you stop early, the system will automatically continue you.`
