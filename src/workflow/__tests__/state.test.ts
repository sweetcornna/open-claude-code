import { expect, test } from 'bun:test'
import type { AgentProgress } from '../progress/store.js'
import {
  NO_AGENT_SELECTED,
  clampAgentIndex,
  resolveAgentSelection,
  windowAgents,
} from '../panel/state.js'

function agents(ids: readonly number[]): AgentProgress[] {
  return ids.map(id => ({ id, status: 'done' }))
}

test('clampAgentIndex clamps empty, invalid, and overflowed indices', () => {
  expect(clampAgentIndex(3, 0)).toBe(0)
  expect(clampAgentIndex(-2, 5)).toBe(0)
  expect(clampAgentIndex(Number.NaN, 5)).toBe(0)
  expect(clampAgentIndex(9, 5)).toBe(4)
  expect(clampAgentIndex(2, 5)).toBe(2)
})

test('resolveAgentSelection follows agent id through insertion and reorder', () => {
  const selected = resolveAgentSelection(agents([0, 1, 2, 3, 4]), {
    agentId: 2,
    visualIndex: 2,
  })

  const moved = resolveAgentSelection(
    agents([99, 4, 0, 1, 2, 3]),
    selected.next,
  )

  expect(moved.agent?.id).toBe(2)
  expect(moved.index).toBe(4)
  expect(moved.next).toEqual({ agentId: 2, visualIndex: 4 })
})

test('resolveAgentSelection preserves then clamps visual index after removal', () => {
  const removed = resolveAgentSelection(agents([99, 4, 0, 1, 3]), {
    agentId: 2,
    visualIndex: 3,
  })
  expect(removed.index).toBe(3)
  expect(removed.agent?.id).toBe(1)

  const shortened = resolveAgentSelection(agents([99, 4]), removed.next)
  expect(shortened.index).toBe(1)
  expect(shortened.agent?.id).toBe(4)
})

test('resolveAgentSelection honors an explicit deselection above the first row', () => {
  // Distinct from the initial `{ agentId: null, visualIndex: 0 }`, which still means
  // "first row". Without a representable no-selection state, `x` in the 48–77 column
  // layout could never target the run.
  const none = resolveAgentSelection(agents([0, 1, 2]), {
    agentId: null,
    visualIndex: NO_AGENT_SELECTED,
  })
  expect(none.agent).toBeUndefined()
  expect(none.index).toBe(NO_AGENT_SELECTED)
  expect(none.next).toEqual({ agentId: null, visualIndex: NO_AGENT_SELECTED })

  const initial = resolveAgentSelection(agents([0, 1, 2]), {
    agentId: null,
    visualIndex: 0,
  })
  expect(initial.agent?.id).toBe(0)
})

test('windowAgents leaves nothing highlighted while deselected', () => {
  const list = agents(Array.from({ length: 20 }, (_, index) => index))
  const window = windowAgents(list, NO_AGENT_SELECTED, 5)
  expect(window.visible.map(agent => agent.id)).toEqual([0, 1, 2, 3, 4])
  expect(window.selectedInWindow).toBeLessThan(0)
  expect(window.hiddenAbove).toBe(0)
})

test('windowAgents keeps a short list unchanged', () => {
  const list = agents([0, 1, 2, 3])
  expect(windowAgents(list, 2, 10)).toEqual({
    visible: list,
    selectedInWindow: 2,
    hiddenAbove: 0,
    hiddenBelow: 0,
  })
})

test('windowAgents centers and clamps a long sliding window', () => {
  const list = agents(Array.from({ length: 20 }, (_, index) => index))
  const middle = windowAgents(list, 10, 5)
  expect(middle.visible.map(agent => agent.id)).toEqual([8, 9, 10, 11, 12])
  expect(middle.selectedInWindow).toBe(2)
  expect(middle.hiddenAbove).toBe(8)
  expect(middle.hiddenBelow).toBe(7)

  const tail = windowAgents(list, 19, 5)
  expect(tail.visible.map(agent => agent.id)).toEqual([15, 16, 17, 18, 19])
  expect(tail.selectedInWindow).toBe(4)
  expect(tail.hiddenAbove).toBe(15)
  expect(tail.hiddenBelow).toBe(0)
})

test('windowAgents enforces at least one visible row', () => {
  const window = windowAgents(agents([0, 1, 2, 3, 4]), 3, 0)
  expect(window.visible.map(agent => agent.id)).toEqual([3])
  expect(window.selectedInWindow).toBe(0)
})
