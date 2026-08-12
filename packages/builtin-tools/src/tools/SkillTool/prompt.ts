import { memoize } from 'lodash-es'
import type { Command } from 'src/commands.js'
import {
  getCommandName,
  getSkillToolCommands,
  getSlashCommandToolSkills,
} from 'src/commands.js'
import { COMMAND_NAME_TAG } from 'src/constants/xml.js'
import {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MAX_LISTING_DESC_CHARS,
  SKILL_BUDGET_CONTEXT_PERCENT,
  type SkillListingBudgetOptions,
} from './constants.js'
import { stringWidth } from '@anthropic/ink'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '@open-claude-code/tool-runtime/analytics.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { toError } from '@open-claude-code/tool-runtime/errors.js'
import { logError } from 'src/utils/telemetry/log.js'

// The budget vocabulary lives in ./constants.ts (a true leaf) so the settings
// reader and /skill-doctor can use it without importing this module's graph.
// Re-exported here to keep the existing public surface intact.
export {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MAX_LISTING_DESC_CHARS,
  SKILL_BUDGET_CONTEXT_PERCENT,
  type SkillListingBudgetOptions,
} from './constants.js'

function resolveBudgetFraction(options?: SkillListingBudgetOptions): number {
  const fraction = options?.budgetFraction
  return fraction !== undefined && fraction > 0 && fraction <= 1
    ? fraction
    : SKILL_BUDGET_CONTEXT_PERCENT
}

function resolveMaxDescChars(options?: SkillListingBudgetOptions): number {
  const max = options?.maxDescChars
  return max !== undefined && Number.isInteger(max) && max > 0
    ? max
    : MAX_LISTING_DESC_CHARS
}

export function getCharBudget(
  contextWindowTokens?: number,
  options?: SkillListingBudgetOptions,
): number {
  if (Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)) {
    return Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  }
  const windowTokens =
    contextWindowTokens && contextWindowTokens > 0
      ? contextWindowTokens
      : DEFAULT_CONTEXT_WINDOW_TOKENS
  return Math.max(
    1,
    Math.floor(windowTokens * CHARS_PER_TOKEN * resolveBudgetFraction(options)),
  )
}

function getCommandDescription(cmd: Command, maxDescChars: number): string {
  const desc = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description
  return desc.length > maxDescChars
    ? desc.slice(0, maxDescChars - 1) + '\u2026'
    : desc
}

function formatCommandDescription(cmd: Command, maxDescChars: number): string {
  // Debug: log if userFacingName differs from cmd.name for plugin skills
  const displayName = getCommandName(cmd)
  if (
    cmd.name !== displayName &&
    cmd.type === 'prompt' &&
    cmd.source === 'plugin'
  ) {
    logForDebugging(
      `Skill prompt: showing "${cmd.name}" (userFacingName="${displayName}")`,
    )
  }

  return `- ${cmd.name}: ${getCommandDescription(cmd, maxDescChars)}`
}

/** One rendered line of the skill listing, with its accounting. */
export type SkillListingEntry = {
  command: Command
  /** The line exactly as it appears in the listing sent to the model. */
  entry: string
  /** Display width of `entry`, the unit the budget is measured in. */
  chars: number
  /**
   * True when the budget dropped this skill's description, leaving a name-only
   * line. Degradation is all-or-nothing per skill: the budget never delivers a
   * half-sentence. The per-skill `maxDescChars` cap is applied before this and
   * is not reported here — it shapes the "full" form itself.
   */
  degraded: boolean
}

export type SkillListingResult = {
  entries: SkillListingEntry[]
  /** Character budget the listing had to fit into. */
  budget: number
  /** Width the listing would have taken with every description at full length. */
  fullTotal: number
  /** Width the listing actually takes (entries plus joining newlines). */
  totalChars: number
  /** True when `fullTotal` exceeded `budget`, i.e. degradation kicked in. */
  overBudget: boolean
}

/**
 * Budget-aware skill listing, returned per entry so callers can attribute cost
 * to individual skills (see `/skill-doctor`). `formatCommandsWithinBudget` is
 * the string-producing wrapper used to build the actual attachment.
 */
export function buildSkillListing(
  commands: Command[],
  contextWindowTokens?: number,
  options?: SkillListingBudgetOptions,
): SkillListingResult {
  const budget = getCharBudget(contextWindowTokens, options)
  if (commands.length === 0) {
    return {
      entries: [],
      budget,
      fullTotal: 0,
      totalChars: 0,
      overBudget: false,
    }
  }

  const maxDescChars = resolveMaxDescChars(options)

  // Try full descriptions first
  const fullEntries = commands.map(cmd => ({
    cmd,
    full: formatCommandDescription(cmd, maxDescChars),
  }))
  // join('\n') produces N-1 newlines for N entries
  const fullTotal =
    fullEntries.reduce((sum, e) => sum + stringWidth(e.full), 0) +
    (fullEntries.length - 1)

  if (fullTotal <= budget) {
    return finishListing(
      fullEntries,
      fullEntries.map(e => e.full),
      {
        budget,
        fullTotal,
        overBudget: false,
      },
    )
  }

  logForDebugging(
    `Skill listing over budget: ${commands.length} skills, ${fullTotal} chars > ${budget} budget — descriptions will be truncated. Run /skills to disable some, or raise skillListingBudgetFraction in settings.`,
    { level: 'warn' },
  )

  // Locked: bundled skills keep their full entry no matter what. They are
  // Anthropic-curated and small, and degrading them buys almost nothing.
  const lockedIndices = new Set<number>()
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!
    if (cmd.type === 'prompt' && cmd.source === 'bundled') {
      lockedIndices.add(i)
    }
  }

  const candidateIndices = commands
    .map((_, i) => i)
    .filter(i => !lockedIndices.has(i))

  // Everything is locked — there is nothing left to shrink.
  if (candidateIndices.length === 0) {
    return finishListing(
      fullEntries,
      fullEntries.map(e => e.full),
      {
        budget,
        fullTotal,
        overBudget: true,
      },
    )
  }

  const nameOnlyWidth = (i: number) => stringWidth(`- ${commands[i]!.name}`)
  const fullWidth = (i: number) => stringWidth(fullEntries[i]!.full)

  // Baseline: locked entries at full width, every candidate stripped to its
  // name. This is the floor the listing can always afford to print, which is
  // what guarantees every skill stays listed — and therefore invocable — even
  // when the budget is hopeless.
  const baseline =
    commands.reduce(
      (sum, _, i) =>
        sum + (lockedIndices.has(i) ? fullWidth(i) : nameOnlyWidth(i)),
      0,
    ) +
    (commands.length - 1)

  // Spend what's left on the skills most likely to be reached for, so a
  // crowded listing degrades where it costs the least. Descending by usage
  // score; Array.sort is stable, so equal scores (including the all-zero case
  // of a fresh install) keep their original listing order.
  const scoreOf = options?.usageScore ?? (() => 0)
  const ranked = [...candidateIndices].sort(
    (a, b) => scoreOf(commands[b]!.name) - scoreOf(commands[a]!.name),
  )

  let remaining = budget - baseline
  const promoted = new Set<number>()
  for (const i of ranked) {
    const upgradeCost = fullWidth(i) - nameOnlyWidth(i)
    if (upgradeCost <= remaining) {
      promoted.add(i)
      remaining -= upgradeCost
    }
  }

  if (process.env.USER_TYPE === 'ant') {
    logEvent('tengu_skill_descriptions_truncated', {
      skill_count: commands.length,
      budget,
      full_total: fullTotal,
      truncation_mode:
        'usage_ranked' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      promoted_count: promoted.size,
      name_only_count: candidateIndices.length - promoted.size,
      bundled_count: lockedIndices.size,
    })
  }

  return finishListing(
    fullEntries,
    commands.map((cmd, i) =>
      lockedIndices.has(i) || promoted.has(i)
        ? fullEntries[i]!.full
        : `- ${cmd.name}`,
    ),
    { budget, fullTotal, overBudget: true },
  )
}

/**
 * Zips the rendered lines back onto their commands and totals the result.
 * `rendered[i]` must correspond to `fullEntries[i]`.
 */
function finishListing(
  fullEntries: Array<{ cmd: Command; full: string }>,
  rendered: string[],
  totals: { budget: number; fullTotal: number; overBudget: boolean },
): SkillListingResult {
  const entries = fullEntries.map((e, i) => {
    const entry = rendered[i]!
    return {
      command: e.cmd,
      entry,
      chars: stringWidth(entry),
      degraded: entry !== e.full,
    }
  })
  return {
    entries,
    budget: totals.budget,
    fullTotal: totals.fullTotal,
    // join('\n') produces N-1 newlines for N entries
    totalChars:
      entries.reduce((sum, e) => sum + e.chars, 0) + (entries.length - 1),
    overBudget: totals.overBudget,
  }
}

/**
 * The skill listing as a single string — what actually ships in the
 * `skill_listing` attachment.
 */
export function formatCommandsWithinBudget(
  commands: Command[],
  contextWindowTokens?: number,
  options?: SkillListingBudgetOptions,
): string {
  return buildSkillListing(commands, contextWindowTokens, options)
    .entries.map(e => e.entry)
    .join('\n')
}

export const getPrompt = memoize(async (_cwd: string): Promise<string> => {
  return `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "commit", args: "-m 'Fix bug'"\` - invoke with arguments
  - \`skill: "review-pr", args: "123"\` - invoke with arguments
  - \`skill: "ms-office-suite:pdf"\` - invoke using fully qualified name

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <${COMMAND_NAME_TAG}> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
`
})

export async function getSkillToolInfo(cwd: string): Promise<{
  totalCommands: number
  includedCommands: number
}> {
  const agentCommands = await getSkillToolCommands(cwd)

  return {
    totalCommands: agentCommands.length,
    includedCommands: agentCommands.length,
  }
}

// Returns the commands included in the SkillTool prompt.
// All commands are always included (descriptions may be truncated to fit budget).
// Used by analyzeContext to count skill tokens.
export function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return getSkillToolCommands(cwd)
}

export function clearPromptCache(): void {
  getPrompt.cache?.clear?.()
}

export async function getSkillInfo(cwd: string): Promise<{
  totalSkills: number
  includedSkills: number
}> {
  try {
    const skills = await getSlashCommandToolSkills(cwd)

    return {
      totalSkills: skills.length,
      includedSkills: skills.length,
    }
  } catch (error) {
    logError(toError(error))

    // Return zeros rather than throwing - let caller decide how to handle
    return {
      totalSkills: 0,
      includedSkills: 0,
    }
  }
}
