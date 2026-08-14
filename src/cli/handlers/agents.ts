/**
 * Agents subcommand handlers.
 *
 * Two surfaces share the command: `occ agents` on a TTY mounts FleetView (the
 * interactive session list), while `occ agents --list` keeps the original text
 * dump of configured agent definitions. Piped or CI invocations fall back to
 * the text dump on their own — a TUI written to a pipe is not output.
 *
 * Dynamically imported only when `occ agents` runs.
 */

import {
  AGENT_SOURCE_GROUPS,
  compareAgentsByName,
  getOverrideSourceLabel,
  type ResolvedAgent,
  resolveAgentModelDisplay,
  resolveAgentOverrides,
} from '@open-claude-code/builtin-tools/tools/AgentTool/agentDisplay.js'
import {
  getActiveAgentsFromList,
  getAgentDefinitionsWithOverrides,
} from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { getCwd } from '../../utils/filesystem/cwd.js'

/**
 * Whether this invocation gets the interactive fleet list.
 *
 * Both streams matter: FleetView needs stdout to draw and stdin to take
 * keystrokes, and a session started with stdin redirected would otherwise mount
 * a list nobody can move. `--list` is the explicit opt-out and wins over TTY
 * detection.
 */
export function shouldMountFleetView(
  options: { json?: boolean; list?: boolean },
  streams: { stdoutIsTTY?: boolean; stdinIsTTY?: boolean },
): boolean {
  // `--json` is the machine-readable surface and must never mount a TUI, even
  // on a TTY — that is the whole point of having it.
  if (options.json || options.list) return false
  return Boolean(streams.stdoutIsTTY) && Boolean(streams.stdinIsTTY)
}

/**
 * `occ agents --json` — print the running/recent session list as a JSON array.
 *
 * Never requires a TTY (matching upstream), so it is usable from scripts, CI
 * and sibling agents. Writes exactly one line: `JSON.stringify(entries)`.
 */
export async function agentsJsonHandler(options: {
  all?: boolean
  cwd?: string
}): Promise<void> {
  const [{ fleetRowsToJson }, { loadFleetRows }, { resolve }] =
    await Promise.all([
      import('../../components/fleet/fleetJson.js'),
      import('../../components/fleet/loadFleetRows.js'),
      import('path'),
    ])
  const rows = await loadFleetRows()
  const entries = fleetRowsToJson(rows, {
    all: options.all,
    ...(options.cwd !== undefined && { cwd: resolve(options.cwd) }),
  })
  console.log(JSON.stringify(entries))
}

function formatAgent(agent: ResolvedAgent): string {
  const model = resolveAgentModelDisplay(agent)
  const parts = [agent.agentType]
  if (model) {
    parts.push(model)
  }
  if (agent.memory) {
    parts.push(`${agent.memory} memory`)
  }
  return parts.join(' · ')
}

export async function agentsHandler(): Promise<void> {
  const cwd = getCwd()
  const { allAgents } = await getAgentDefinitionsWithOverrides(cwd)
  const activeAgents = getActiveAgentsFromList(allAgents)
  const resolvedAgents = resolveAgentOverrides(allAgents, activeAgents)

  const lines: string[] = []
  let totalActive = 0

  for (const { label, source } of AGENT_SOURCE_GROUPS) {
    const groupAgents = resolvedAgents
      .filter(a => a.source === source)
      .sort(compareAgentsByName)

    if (groupAgents.length === 0) continue

    lines.push(`${label}:`)
    for (const agent of groupAgents) {
      if (agent.overriddenBy) {
        const winnerSource = getOverrideSourceLabel(agent.overriddenBy)
        lines.push(`  (shadowed by ${winnerSource}) ${formatAgent(agent)}`)
      } else {
        lines.push(`  ${formatAgent(agent)}`)
        totalActive++
      }
    }
    lines.push('')
  }

  if (lines.length === 0) {
    console.log('No agents found.')
  } else {
    console.log(`${totalActive} active agents\n`)
    console.log(lines.join('\n').trimEnd())
  }
}
