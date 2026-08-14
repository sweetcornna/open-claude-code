/**
 * `plugin details` — what a plugin puts in the context window, split by when
 * you pay for it.
 *
 * Two numbers, and the split is the whole point:
 *
 * - **always_on** — the listing lines the plugin contributes to *every* turn.
 *   A skill's line is `- name: description`, an agent's is
 *   `- type: whenToUse (Tools: …)`. This is the number that competes with your
 *   conversation for context, and the one the skill-listing budget rations.
 * - **on_invoke** — the component body, loaded only when the model actually
 *   reaches for it. Usually one or two orders of magnitude larger, and usually
 *   irrelevant: you pay it once, deliberately, in exchange for the work.
 *
 * Both are measured, not guessed. The listing lines come out of
 * `buildSkillListing` / `formatAgentLine` — the same formatters that build the
 * strings actually sent — and the bodies are the real file contents the
 * loaders read. The only estimated quantity is the chars→tokens conversion,
 * and only when {@link computePluginDetails}' `countTokens` hook is absent or
 * the API declines; `tokenSource` says which happened.
 *
 * Calibration is deliberately shared with `/skill-doctor`: same
 * `getSkillListingBudgetOptions()`, same `stringWidth` character unit, same
 * `CHARS_PER_TOKEN` fallback. Two commands that answer "what does my context
 * cost" must not disagree about the units.
 */

import { formatAgentLine } from '@open-claude-code/builtin-tools/tools/AgentTool/agentListing.js'
import type { AgentDefinition } from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import {
  CHARS_PER_TOKEN,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  type SkillListingBudgetOptions,
} from '@open-claude-code/builtin-tools/tools/SkillTool/constants.js'
import {
  buildSkillListing,
  getCharBudget,
} from '@open-claude-code/builtin-tools/tools/SkillTool/prompt.js'
import { stringWidth } from '@anthropic/ink'
import type { Command } from '../../types/command.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { loadAgentsForPlugin } from './loadPluginAgents.js'
import {
  loadCommandsForPlugin,
  loadSkillsForPlugin,
} from './loadPluginCommands.js'
import { loadPluginLspServers } from './lspPluginIntegration.js'
import { loadPluginMcpServers } from './mcpPluginIntegration.js'

export type PluginComponentKind = 'skill' | 'command' | 'agent'

/** One component's footprint, split by when the context is spent. */
export type PluginComponentCost = {
  kind: PluginComponentKind
  name: string
  /**
   * The listing line this component contributes every turn, verbatim.
   * Empty when {@link listed} is false.
   */
  alwaysOnLine: string
  /** Display width of {@link alwaysOnLine}; 0 when not listed. */
  alwaysOnChars: number
  /** Display width of the body loaded only on invocation. */
  onInvokeChars: number
  /**
   * Whether the component reaches the model's always-on listing at all.
   *
   * False for plugin commands with neither a frontmatter `description` nor a
   * `when_to_use` — `getSkillToolCommands` filters those out, so they cost
   * nothing per turn and are reachable only by the user typing `/name`.
   */
  listed: boolean
}

export type PluginCost = {
  alwaysOnChars: number
  onInvokeChars: number
  alwaysOnTokens: number
  onInvokeTokens: number
  /**
   * How `alwaysOnTokens` was obtained: `api` when a real tokenizer counted the
   * exact listing text, `chars` when that was unavailable (offline,
   * unauthenticated, or a provider with no count endpoint) and the total was
   * derived from `alwaysOnChars` at the listing budget's own `CHARS_PER_TOKEN`
   * rate.
   *
   * `onInvokeTokens` is always the derived form: `Command` carries
   * `contentLength`, not the body text (see {@link bodyChars}), so there is no
   * string to hand a tokenizer without re-reading and re-parsing every
   * component file — and the always-on side is the one that competes with the
   * conversation on every turn.
   */
  tokenSource: 'api' | 'chars'
  /** Character budget the whole skill listing must fit into. */
  budgetChars: number
  /** Context window the budget was derived from, in tokens. */
  contextWindowTokens: number
  /** `alwaysOnChars / budgetChars`, i.e. this plugin's share of the listing. */
  shareOfBudget: number
}

export type PluginDetails = {
  pluginId: string
  name: string
  version?: string
  path: string
  enabled: boolean
  skills: PluginComponentCost[]
  commands: PluginComponentCost[]
  agents: PluginComponentCost[]
  hooks: string[]
  mcpServers: string[]
  lspServers: string[]
  cost: PluginCost
}

/**
 * A plugin command reaches the always-on listing only under the same filter
 * `getSkillToolCommands` applies. Duplicated here rather than called because
 * that helper loads *every* command in the session (and needs a cwd and the
 * whole `src/commands.ts` graph) to answer a question about one plugin.
 *
 * Mirrors the `source === 'plugin'` branch of that filter: plugin entries need
 * an explicit description or `when_to_use`; the `loadedFrom` escape hatches
 * there are for bundled / user-skills / legacy-commands sources, which by
 * construction never appear in a plugin's output.
 */
function reachesListing(cmd: Command): boolean {
  return (
    cmd.type === 'prompt' &&
    !cmd.disableModelInvocation &&
    (cmd.hasUserSpecifiedDescription === true || Boolean(cmd.whenToUse))
  )
}

/**
 * Body size for a prompt command. `contentLength` is recorded by
 * `createPluginCommand` at load time from the post-frontmatter markdown — the
 * bytes that become the prompt.
 *
 * Not `getPromptForCommand()`: that runs the command's `!`-prefixed shell
 * blocks. Reporting a cost must never execute plugin-authored code.
 */
function bodyChars(cmd: Command): number {
  return cmd.type === 'prompt' ? (cmd.contentLength ?? 0) : 0
}

function costForCommands(
  commands: Command[],
  kind: 'skill' | 'command',
  budgetOptions: SkillListingBudgetOptions,
): PluginComponentCost[] {
  const listedCommands = commands.filter(reachesListing)

  // A budget large enough that nothing degrades: this reports the plugin's
  // full always-on footprint. Whether the *session* can afford it is a
  // whole-listing property that depends on every other skill installed, which
  // is exactly what /skill-doctor answers.
  const listing = buildSkillListing(
    listedCommands,
    Number.MAX_SAFE_INTEGER / CHARS_PER_TOKEN,
    { ...budgetOptions, usageScore: undefined },
  )
  const byName = new Map(
    listing.entries.map(entry => [entry.command.name, entry]),
  )

  return commands.map(cmd => {
    const entry = byName.get(cmd.name)
    return {
      kind,
      name: cmd.name,
      alwaysOnLine: entry?.entry ?? '',
      alwaysOnChars: entry?.chars ?? 0,
      onInvokeChars: bodyChars(cmd),
      listed: entry !== undefined,
    }
  })
}

function costForAgents(agents: AgentDefinition[]): PluginComponentCost[] {
  return agents.map(agent => {
    const line = formatAgentLine(agent)
    return {
      kind: 'agent' as const,
      name: agent.agentType,
      alwaysOnLine: line,
      alwaysOnChars: stringWidth(line),
      onInvokeChars:
        'getSystemPrompt' in agent && agent.source !== 'built-in'
          ? agent.getSystemPrompt().length
          : 0,
      // Plugin agents always enter the active list unless a same-named agent
      // from a higher-precedence source shadows them (see
      // getActiveAgentsFromList). Shadowing is a whole-session property, so
      // this reports the plugin's own contribution.
      listed: true,
    }
  })
}

function sumChars(
  groups: PluginComponentCost[][],
  pick: (c: PluginComponentCost) => number,
): number {
  let total = 0
  for (const group of groups) {
    for (const component of group) total += pick(component)
  }
  return total
}

/** Newlines joining N listing lines. Matches `buildSkillListing`'s accounting. */
function joinOverhead(count: number): number {
  return count > 0 ? count - 1 : 0
}

export type ComputePluginDetailsOptions = {
  /** Context window the listing budget is derived from, in tokens. */
  contextWindowTokens?: number
  /** Settings-backed budget knobs; pass `getSkillListingBudgetOptions()`. */
  budgetOptions?: SkillListingBudgetOptions
  /**
   * Real tokenizer. Injected so this module stays pure and offline-testable —
   * the CLI passes `countTokensWithAPI`. Returning `null` (no auth, no
   * network, provider without a count endpoint) degrades to the character
   * rate and is reported as such via `tokenSource`.
   */
  countTokens?: (content: string) => Promise<number | null>
}

/**
 * Inventory one plugin and price it. `plugin` may be disabled — the loaders
 * are per-plugin, so a disabled plugin can be costed before you enable it.
 */
export async function computePluginDetails(
  plugin: LoadedPlugin,
  options: ComputePluginDetailsOptions = {},
): Promise<PluginDetails> {
  const budgetOptions = options.budgetOptions ?? {}

  const [rawSkills, rawCommands, rawAgents, mcpServers, lspServers] =
    await Promise.all([
      loadSkillsForPlugin(plugin),
      loadCommandsForPlugin(plugin),
      loadAgentsForPlugin(plugin),
      loadPluginMcpServers(plugin).catch(() => undefined),
      loadPluginLspServers(plugin).catch(() => undefined),
    ])

  const skills = costForCommands(rawSkills, 'skill', budgetOptions)
  const commands = costForCommands(rawCommands, 'command', budgetOptions)
  const agents = costForAgents(rawAgents)
  const groups = [skills, commands, agents]

  const listedCount = groups.reduce(
    (n, group) => n + group.filter(c => c.listed).length,
    0,
  )
  const alwaysOnChars =
    sumChars(groups, c => c.alwaysOnChars) + joinOverhead(listedCount)
  const onInvokeChars = sumChars(groups, c => c.onInvokeChars)

  const budgetChars = getCharBudget(options.contextWindowTokens, budgetOptions)

  // The exact text the model carries every turn, joined the way the listing
  // joins it. One tokenizer call, on the real string — not a per-component
  // estimate summed up, which would round N times instead of once.
  const alwaysOnText = groups
    .flatMap(group => group.filter(c => c.listed).map(c => c.alwaysOnLine))
    .join('\n')
  const alwaysOnTokens = options.countTokens
    ? await options.countTokens(alwaysOnText)
    : null

  const fromChars = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN)

  return {
    pluginId: plugin.source,
    name: plugin.name,
    version: plugin.manifest.version,
    path: plugin.path,
    enabled: plugin.enabled !== false,
    skills,
    commands,
    agents,
    hooks: plugin.hooksConfig ? Object.keys(plugin.hooksConfig) : [],
    mcpServers: mcpServers ? Object.keys(mcpServers) : [],
    lspServers: lspServers ? Object.keys(lspServers) : [],
    cost: {
      alwaysOnChars,
      onInvokeChars,
      alwaysOnTokens: alwaysOnTokens ?? fromChars(alwaysOnChars),
      onInvokeTokens: fromChars(onInvokeChars),
      tokenSource: alwaysOnTokens !== null ? 'api' : 'chars',
      budgetChars,
      contextWindowTokens:
        options.contextWindowTokens && options.contextWindowTokens > 0
          ? options.contextWindowTokens
          : DEFAULT_CONTEXT_WINDOW_TOKENS,
      shareOfBudget: budgetChars > 0 ? alwaysOnChars / budgetChars : 0,
    },
  }
}
