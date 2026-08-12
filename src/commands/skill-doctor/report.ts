import {
  CHARS_PER_TOKEN,
  SKILL_TOOL_NAME,
} from '@open-claude-code/builtin-tools/tools/SkillTool/constants.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import type { Message } from '../../types/message.js'

/**
 * How often a single skill ran this session, split by how we saw it.
 *
 * Module-private: callers only ever pass `countSkillInvocations`' return value
 * straight into `buildSkillDoctorReport`, so nothing outside needs to name it.
 */
type SkillInvocationCounts = {
  /** `Skill` tool_use blocks — the model reaching for the skill itself. */
  viaTool: number
  /**
   * `<command-name>` breadcrumbs. Every prompt-command load emits one, from
   * either origin: `processSlashCommand` formats the breadcrumb for the user
   * typing `/name` and for the Skill tool loading the same skill.
   */
  viaBreadcrumb: number
  /**
   * Times the skill ran this session. The two counters overlap — a
   * user-invocable skill the model calls through the Skill tool produces both
   * a tool_use block and a breadcrumb — so summing would double-count. `max`
   * keeps user-typed `/name` runs visible without inflating model-driven ones.
   */
  total: number
}

const COMMAND_NAME_RE = new RegExp(
  `<${COMMAND_NAME_TAG}>([^<]*)</${COMMAND_NAME_TAG}>`,
  'g',
)

function bump(counts: Map<string, number>, name: string): void {
  counts.set(name, (counts.get(name) ?? 0) + 1)
}

function textBlocksOf(message: Message): string[] {
  const content = message.message?.content
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const texts: string[] = []
  for (const block of content as Array<{ type?: string; text?: unknown }>) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text)
    }
  }
  return texts
}

/**
 * Which skills ran in this session, read straight off the in-memory message
 * list — the same array the REPL renders and `query()` sends to the API.
 *
 * Deliberately not the global `skillUsage` config that `recordSkillUsage`
 * writes: that one is cross-session and debounced to a minute, so it answers
 * "do I reach for this skill in general", not "did this conversation pay for
 * the listing entry it's carrying".
 */
export function countSkillInvocations(
  messages: Message[],
): Map<string, SkillInvocationCounts> {
  const viaTool = new Map<string, number>()
  const viaBreadcrumb = new Map<string, number>()

  for (const message of messages) {
    if (!message) continue

    if (message.type === 'assistant') {
      const content = message.message?.content
      if (!Array.isArray(content)) continue
      for (const block of content as Array<{
        type?: string
        name?: string
        input?: unknown
      }>) {
        if (block?.type !== 'tool_use' || block.name !== SKILL_TOOL_NAME) {
          continue
        }
        const skill = (block.input as { skill?: unknown } | undefined)?.skill
        if (typeof skill === 'string' && skill.length > 0) {
          bump(viaTool, skill)
        }
      }
      continue
    }

    if (message.type !== 'user') continue
    for (const text of textBlocksOf(message)) {
      for (const match of text.matchAll(COMMAND_NAME_RE)) {
        // User-invocable skills render as "/name"; model-only skills as "name".
        const name = (match[1] ?? '').trim().replace(/^\//, '')
        if (name) bump(viaBreadcrumb, name)
      }
    }
  }

  const result = new Map<string, SkillInvocationCounts>()
  for (const name of new Set([...viaTool.keys(), ...viaBreadcrumb.keys()])) {
    const tool = viaTool.get(name) ?? 0
    const breadcrumb = viaBreadcrumb.get(name) ?? 0
    result.set(name, {
      viaTool: tool,
      viaBreadcrumb: breadcrumb,
      total: Math.max(tool, breadcrumb),
    })
  }
  return result
}

/** One skill's footprint in the listing that was sent to the model. */
export type SkillListingCost = {
  name: string
  /** `loadedFrom` — bundled / skills / plugin / mcp / … */
  source: string
  /** Display width of this skill's listing line. */
  chars: number
  /** True when the budget shortened this line below its full form. */
  degraded: boolean
}

/**
 * Module-private: callers build this inline at the `buildSkillDoctorReport`
 * call site from a `SkillListingResult`, so nothing outside needs to name it.
 */
type SkillDoctorTotals = {
  /** Character budget the listing had to fit into. */
  budget: number
  /** Width the listing actually takes. */
  totalChars: number
  /** Width it would take with every description at full length. */
  fullTotal: number
  overBudget: boolean
  /** Context window the budget was derived from, in tokens. */
  contextWindowTokens: number
}

/**
 * A skill is called out as expensive when its single line eats this share of
 * the whole listing budget. Purely advisory — it drives a marker, not a cut.
 */
const COSTLY_SHARE_OF_BUDGET = 0.05

function approxTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function num(value: number): string {
  return value.toLocaleString('en-US')
}

function cost(chars: number): string {
  return `${num(chars)} chars (~${num(approxTokens(chars))} tokens)`
}

function line(entry: SkillListingCost, invocations: number): string {
  const parts = [`- \`${entry.name}\``, `— ${cost(entry.chars)}`]
  parts.push(`[${entry.source}]`)
  if (invocations > 0) {
    parts.push(`· used ${invocations}×`)
  }
  if (entry.degraded) {
    parts.push('· truncated to fit budget')
  }
  return parts.join(' ')
}

/**
 * Renders the `/skill-doctor` report: what the skill listing costs this
 * session, and which of those skills never earned their keep.
 */
export function buildSkillDoctorReport(
  costs: SkillListingCost[],
  invocations: Map<string, SkillInvocationCounts>,
  totals: SkillDoctorTotals,
): string {
  const out: string[] = ['## Skill Doctor', '']

  if (costs.length === 0) {
    out.push(
      'No skills are loaded in this session — the listing costs nothing.',
    )
    return out.join('\n')
  }

  const used: SkillListingCost[] = []
  const unused: SkillListingCost[] = []
  for (const entry of costs) {
    if ((invocations.get(entry.name)?.total ?? 0) > 0) used.push(entry)
    else unused.push(entry)
  }

  const byCost = (a: SkillListingCost, b: SkillListingCost) =>
    b.chars - a.chars || a.name.localeCompare(b.name)
  used.sort(byCost)
  unused.sort(byCost)

  const unusedChars = unused.reduce((sum, e) => sum + e.chars, 0)
  const budgetPercent = ((totals.totalChars / totals.budget) * 100).toFixed(1)

  out.push(
    `Loaded skills: **${num(costs.length)}** — ${cost(totals.totalChars)}`,
    `Budget: ${num(totals.budget)} chars (${budgetPercent}% used, derived from a ${num(totals.contextWindowTokens)}-token context window)`,
    `Used this session: **${num(used.length)}** of ${num(costs.length)}`,
  )

  if (totals.overBudget) {
    out.push(
      '',
      `> Over budget: full descriptions would need ${cost(totals.fullTotal)}, so entries below marked "truncated" were shortened.`,
      '> Raise `skillListingBudgetFraction` (or lower `skillListingMaxDescChars`) in settings.json to change the trade-off.',
    )
  }

  if (unused.length > 0) {
    const share = totals.totalChars
      ? Math.round((unusedChars / totals.totalChars) * 100)
      : 0
    out.push(
      '',
      `### Never used this session — ${num(unused.length)} skill${unused.length === 1 ? '' : 's'}, ${cost(unusedChars)} (${share}% of the listing)`,
      '',
    )
    const costlyThreshold = totals.budget * COSTLY_SHARE_OF_BUDGET
    for (const entry of unused) {
      const marker = entry.chars >= costlyThreshold ? ' **← costly**' : ''
      out.push(`${line(entry, 0)}${marker}`)
    }
  }

  if (used.length > 0) {
    out.push('', `### Used this session — ${num(used.length)}`, '')
    for (const entry of used) {
      out.push(line(entry, invocations.get(entry.name)?.total ?? 0))
    }
  }

  out.push(
    '',
    'Unused skills still cost context every turn the listing is cached. Disable the ones you never reach for (remove the skill directory, or drop the plugin) to reclaim their share.',
  )

  return out.join('\n')
}
