/**
 * `occ plugin details <name>` — a plugin's component inventory and what it
 * costs the context window, split into always-on and on-invoke.
 *
 * Registration lives here (next to the rendering) rather than in
 * `src/cli/program/commands/plugin.tsx`, following `registerMcpAddCommand`:
 * the CLI module keeps a one-line call and every plugin-details concern stays
 * in one file.
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handlers intentionally exit */
import type { Command as CommanderCommand } from '@commander-js/extra-typings'
import figures from 'figures'
import { setUseCoworkPlugins } from '../../bootstrap/state.js'
import { cliError, cliOk } from '../../cli/exit.js'
import { BIN_NAME } from '../../constants/brand.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import {
  computePluginDetails,
  type PluginComponentCost,
  type PluginDetails,
} from '../../utils/plugins/pluginDetails.js'
import { parsePluginIdentifier } from '../../utils/plugins/pluginIdentifier.js'
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js'
import { jsonStringify } from '../../utils/telemetry/slowOperations.js'

/**
 * Resolve a user-typed plugin reference against everything on disk.
 *
 * Accepts `name@marketplace` (exact) or a bare `name` (unique match required).
 * Disabled plugins resolve too — "what would this cost me if I turned it on"
 * is the main reason to ask.
 */
export function resolvePluginByName(
  plugins: LoadedPlugin[],
  reference: string,
):
  | { kind: 'found'; plugin: LoadedPlugin }
  | { kind: 'not-found' }
  | { kind: 'ambiguous'; matches: string[] } {
  const exact = plugins.find(p => p.source === reference)
  if (exact) return { kind: 'found', plugin: exact }

  // A bare name may match several marketplaces. Refusing beats guessing: the
  // two candidates can have completely different component sets.
  if (!parsePluginIdentifier(reference).marketplace) {
    const byName = plugins.filter(p => p.name === reference)
    if (byName.length === 1) return { kind: 'found', plugin: byName[0]! }
    if (byName.length > 1) {
      return { kind: 'ambiguous', matches: byName.map(p => p.source).sort() }
    }
  }
  return { kind: 'not-found' }
}

function num(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

function componentLines(
  label: string,
  components: PluginComponentCost[],
): string[] {
  if (components.length === 0) return []
  const out = [`  ${label} (${components.length}):`]
  const sorted = [...components].sort(
    (a, b) => b.alwaysOnChars - a.alwaysOnChars || a.name.localeCompare(b.name),
  )
  for (const c of sorted) {
    const always = c.listed
      ? `always_on ${num(c.alwaysOnChars)} chars`
      : 'always_on 0 chars (not listed — no description)'
    out.push(
      `    ${figures.pointer} ${c.name} — ${always} · on_invoke ${num(c.onInvokeChars)} chars`,
    )
  }
  return out
}

function namedList(label: string, names: string[]): string[] {
  if (names.length === 0) return []
  return [`  ${label} (${names.length}): ${[...names].sort().join(', ')}`]
}

/** Human-readable report. `--json` bypasses this and dumps {@link PluginDetails}. */
export function renderPluginDetails(details: PluginDetails): string {
  const { cost } = details
  const sharePercent = (cost.shareOfBudget * 100).toFixed(1)
  const tokenNote =
    cost.tokenSource === 'api'
      ? ''
      : ' (estimated from characters — token counting unavailable)'

  const lines: string[] = [
    `${details.pluginId}${details.version ? ` v${details.version}` : ''}`,
    `  Path: ${details.path}`,
    `  Status: ${details.enabled ? `${figures.tick} enabled` : `${figures.cross} disabled`}`,
    '',
    'Components:',
  ]

  const componentSections = [
    ...componentLines('Skills', details.skills),
    ...componentLines('Commands', details.commands),
    ...componentLines('Agents', details.agents),
    ...namedList('Hooks', details.hooks),
    ...namedList('MCP servers', details.mcpServers),
    ...namedList('LSP servers', details.lspServers),
  ]
  lines.push(
    ...(componentSections.length > 0 ? componentSections : ['  (none)']),
  )

  lines.push(
    '',
    'Context cost:',
    `  always_on:  ${num(cost.alwaysOnChars)} chars / ${num(cost.alwaysOnTokens)} tokens${tokenNote}`,
    `              ${sharePercent}% of the ${num(cost.budgetChars)}-char skill listing budget` +
      ` (from a ${num(cost.contextWindowTokens)}-token context window)`,
    `  on_invoke:  ${num(cost.onInvokeChars)} chars / ~${num(cost.onInvokeTokens)} tokens,` +
      ' paid only when a component is actually invoked',
  )

  if (!details.enabled) {
    lines.push(
      '',
      'This plugin is disabled — it costs nothing today. The numbers above are what enabling it would add.',
    )
  }

  return lines.join('\n')
}

async function pluginDetailsHandler(
  name: string,
  options: { json?: boolean; cowork?: boolean },
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)

  const { enabled, disabled } = await loadAllPlugins()
  const resolved = resolvePluginByName([...enabled, ...disabled], name)

  if (resolved.kind === 'ambiguous') {
    cliError(
      `${figures.cross} "${name}" matches ${resolved.matches.join(', ')}. Use the full plugin@marketplace id.`,
    )
  }
  if (resolved.kind === 'not-found') {
    cliError(
      `${figures.cross} Plugin "${name}" not found. Run \`${BIN_NAME} plugin list\` to see what is installed.`,
    )
  }

  // Imported lazily: both reach into the session graph (settings, model
  // resolution) that the rest of this module deliberately stays clear of.
  const [{ getSkillListingBudgetOptions }, { countTokensWithAPI }] =
    await Promise.all([
      import('../../utils/skills/listingBudget.js'),
      import('../../services/tokenEstimation.js'),
    ])

  const details = await computePluginDetails(resolved.plugin, {
    contextWindowTokens: await resolveContextWindowTokens(),
    budgetOptions: getSkillListingBudgetOptions(),
    countTokens: countTokensWithAPI,
  })

  cliOk(
    options.json
      ? jsonStringify(details, null, 2)
      : renderPluginDetails(details),
  )
}

/**
 * Context window the budget is derived from. Best-effort: a CLI subcommand
 * runs without a session, and model resolution can throw when no provider is
 * configured. Returning undefined lets `getCharBudget` fall back to its
 * documented default rather than failing the whole command.
 */
async function resolveContextWindowTokens(): Promise<number | undefined> {
  try {
    const [{ getContextWindowForModel }, { getMainLoopModel }] =
      await Promise.all([
        import('../../utils/session/context.js'),
        import('../../utils/model/model.js'),
      ])
    return getContextWindowForModel(getMainLoopModel())
  } catch {
    return undefined
  }
}

/** Registers the `plugin details` subcommand on the given Commander command. */
export function registerPluginDetailsCommand(
  pluginCmd: CommanderCommand,
  coworkOption: () => Parameters<CommanderCommand['addOption']>[0],
): void {
  pluginCmd
    .command('details <name>')
    .description("Show a plugin's component inventory and context cost")
    .option('--json', 'Output as JSON')
    .addOption(coworkOption())
    .action(
      async (name: string, options: { json?: boolean; cowork?: boolean }) => {
        await pluginDetailsHandler(name, options)
      },
    )
}
