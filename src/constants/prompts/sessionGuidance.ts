import { feature } from 'bun:bundle'
import { AGENT_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/AgentTool/constants.js'
import { VERIFICATION_AGENT_TYPE } from '@open-claude-code/builtin-tools/tools/AgentTool/constants.js'
import { isForkSubagentEnabled } from '@open-claude-code/builtin-tools/tools/AgentTool/forkSubagent.js'
import { areExplorePlanAgentsEnabled } from '@open-claude-code/builtin-tools/tools/AgentTool/builtInAgents.js'
import {
  EXPLORE_AGENT,
  EXPLORE_AGENT_MIN_QUERIES,
} from '@open-claude-code/builtin-tools/tools/AgentTool/built-in/exploreAgent.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/AskUserQuestionTool/prompt.js'
import { SKILL_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/SkillTool/constants.js'
import { BASH_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/BashTool/toolName.js'
import { GLOB_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/GrepTool/prompt.js'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { hasEmbeddedSearchTools } from '../../utils/tools/embeddedTools.js'
import { isPoorModeActive } from '../../commands/poor/poorMode.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { Command } from '../../types/command.js'
import { bulletSection } from './format.js'
import { getAgentToolSection } from './tools.js'
import {
  DISCOVER_SKILLS_TOOL_NAME,
  getDiscoverSkillsGuidance,
} from './discoverSkills.js'

/**
 * Guidance that varies with what this particular session has available.
 *
 * Everything here must stay AFTER SYSTEM_PROMPT_DYNAMIC_BOUNDARY. Each
 * conditional is a runtime bit that would otherwise multiply the Blake2b
 * prefix-hash variants of the cacheScope:'global' prefix (2^N).
 */
export function getSessionSpecificGuidanceSection(
  enabledTools: Set<string>,
  skillToolCommands: Command[],
): string | null {
  const hasAskUserQuestionTool = enabledTools.has(ASK_USER_QUESTION_TOOL_NAME)
  const hasSkills =
    skillToolCommands.length > 0 && enabledTools.has(SKILL_TOOL_NAME)
  const hasAgentTool = enabledTools.has(AGENT_TOOL_NAME)
  const searchTools = hasEmbeddedSearchTools()
    ? `\`find\` or \`grep\` via the ${BASH_TOOL_NAME} tool`
    : `the ${GLOB_TOOL_NAME} or ${GREP_TOOL_NAME}`

  return bulletSection('Session-specific guidance', [
    hasAskUserQuestionTool
      ? `If you do not understand why the user has denied a tool call, use the ${ASK_USER_QUESTION_TOOL_NAME} to ask them.`
      : null,
    getIsNonInteractiveSession()
      ? null
      : `If you need the user to run a shell command themselves (e.g., an interactive login like \`gcloud auth login\`), suggest they type \`! <command>\` in the prompt — the \`!\` prefix runs the command in this session so its output lands directly in the conversation.`,
    // isForkSubagentEnabled() reads getIsNonInteractiveSession() — must be
    // post-boundary or it fragments the static prefix on session type.
    hasAgentTool ? getAgentToolSection() : null,
    ...(hasAgentTool &&
    areExplorePlanAgentsEnabled() &&
    !isForkSubagentEnabled()
      ? [
          `For simple, directed codebase searches (e.g. for a specific file/class/function) use ${searchTools} directly.`,
          `For broader codebase exploration and deep research, use the ${AGENT_TOOL_NAME} tool with subagent_type=${EXPLORE_AGENT.agentType}. This is slower than using ${searchTools} directly, so use this only when a simple, directed search proves to be insufficient or when your task will clearly require more than ${EXPLORE_AGENT_MIN_QUERIES} queries.`,
        ]
      : []),
    hasSkills
      ? `/<skill-name> (e.g., /commit) is shorthand for users to invoke a user-invocable skill. When executed, the skill gets expanded to a full prompt. Use the ${SKILL_TOOL_NAME} tool to execute them. IMPORTANT: Only use ${SKILL_TOOL_NAME} for skills listed in its user-invocable skills section - do not guess or use built-in CLI commands.`
      : null,
    DISCOVER_SKILLS_TOOL_NAME !== null &&
    hasSkills &&
    enabledTools.has(DISCOVER_SKILLS_TOOL_NAME)
      ? getDiscoverSkillsGuidance()
      : null,
    // Gate mirrors builtInAgents.ts — if the agent is not in the pool, the
    // contract points at a subagent_type that cannot be spawned. Poor mode
    // skips it to save tokens. Kept inline as one ternary condition: feature()
    // from bun:bundle may not appear anywhere else (Bun compiler limit), so
    // this cannot be extracted into a named predicate.
    hasAgentTool &&
    feature('VERIFICATION_AGENT') &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false) &&
    !isPoorModeActive()
      ? getVerificationContract()
      : null,
  ])
}

function getVerificationContract(): string {
  return `The contract: when non-trivial implementation happens on your turn, independent adversarial verification must happen before you report completion — regardless of who did the implementing (you directly, a fork you spawned, or a subagent). You are the one reporting to the user; you own the gate. Non-trivial means: 3+ file edits, backend/API changes, or infrastructure changes. Spawn the ${AGENT_TOOL_NAME} tool with subagent_type="${VERIFICATION_AGENT_TYPE}". Your own checks, caveats, and a fork's self-checks do NOT substitute — only the verifier assigns a verdict; you cannot self-assign PARTIAL. Pass the original user request, all files changed (by anyone), the approach, and the plan file path if applicable. Flag concerns if you have them but do NOT share test results or claim things work. On FAIL: fix, resume the verifier with its findings plus your fix, repeat until PASS. On PASS: spot-check it — re-run 2-3 commands from its report, confirm every PASS has a Command run block with output that matches your re-run. If any PASS lacks a command block or diverges, resume the verifier with the specifics. On PARTIAL (from the verifier): report what passed and what could not be verified.`
}
