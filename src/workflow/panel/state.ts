import type { AgentProgress } from '../progress/store.js'

type AgentSelection = {
  agentId: number | null
  visualIndex: number
}

/**
 * Visual index of the "no agent selected" row that sits above the first agent.
 *
 * It is not decoration: `x` targets the whole run only when nothing is selected (or
 * the phases pane has focus), and the 48–77 column layout drops the phases pane
 * entirely while always keeping an agent selected — which left that width with no
 * way at all to cancel a run. Parking here is the way back to a run-level target.
 */
export const NO_AGENT_SELECTED = -1

export function clampAgentIndex(selected: number, len: number): number {
  if (len === 0) return 0
  const n = Math.trunc(selected)
  if (Number.isNaN(n) || n < 0) return 0
  return Math.min(n, len - 1)
}

/**
 * Keep selection attached to an agent id while rows move. If that id
 * disappears, preserve its previous visual position and clamp to the new list.
 */
export function resolveAgentSelection(
  agents: readonly AgentProgress[],
  selection: AgentSelection,
): { agent: AgentProgress | undefined; index: number; next: AgentSelection } {
  if (agents.length === 0) {
    return {
      agent: undefined,
      index: 0,
      next: { agentId: null, visualIndex: 0 },
    }
  }

  // Explicit deselection: no pinned id AND parked above the list. Distinguished from
  // the initial `{ agentId: null, visualIndex: 0 }`, which still means "first row".
  if (selection.agentId === null && selection.visualIndex < 0) {
    return {
      agent: undefined,
      index: NO_AGENT_SELECTED,
      next: { agentId: null, visualIndex: NO_AGENT_SELECTED },
    }
  }

  const byId =
    selection.agentId === null
      ? -1
      : agents.findIndex(agent => agent.id === selection.agentId)
  const index =
    byId >= 0 ? byId : clampAgentIndex(selection.visualIndex, agents.length)
  const agent = agents[index]
  return {
    agent,
    index,
    next: {
      agentId: agent?.id ?? null,
      visualIndex: index,
    },
  }
}

type AgentWindow = {
  visible: AgentProgress[]
  selectedInWindow: number
  hiddenAbove: number
  hiddenBelow: number
}

/** Sliding row window centered on the current visual selection. */
export function windowAgents(
  agents: AgentProgress[],
  selected: number,
  maxVisible: number = 10,
): AgentWindow {
  const cap = Math.max(1, Math.trunc(maxVisible))
  if (agents.length <= cap) {
    return {
      visible: agents,
      selectedInWindow: selected,
      hiddenAbove: 0,
      hiddenBelow: 0,
    }
  }
  const half = Math.floor(cap / 2)
  // NO_AGENT_SELECTED clamps to the top of the list here, and selectedInWindow stays
  // negative so AgentList highlights nothing.
  const start = Math.min(Math.max(0, selected - half), agents.length - cap)
  return {
    visible: agents.slice(start, start + cap),
    selectedInWindow: selected - start,
    hiddenAbove: start,
    hiddenBelow: agents.length - (start + cap),
  }
}
