// React-free tests for the WorkflowDetailDialog projection layer, mirroring
// workflowTaskSummaryData.test.ts: window/key-routing logic is the testable
// part, and staying off ink keeps this file immune to process-global
// mock.module pollution.

import { expect, test } from 'bun:test'
import type { AgentProgress } from '../../../workflow/progress/store.js'
import {
  clampAgentIndex,
  MAX_VISIBLE_AGENTS,
  routeWorkflowDetailKey,
  windowAgents,
} from '../workflowDetailData.js'

function agents(n: number): AgentProgress[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    status: 'done' as const,
  }))
}

test('clampAgentIndex: empty list → 0; negative/NaN → 0; overflow → last', () => {
  expect(clampAgentIndex(3, 0)).toBe(0)
  expect(clampAgentIndex(-2, 5)).toBe(0)
  expect(clampAgentIndex(Number.NaN, 5)).toBe(0)
  expect(clampAgentIndex(9, 5)).toBe(4)
  expect(clampAgentIndex(2, 5)).toBe(2)
})

test('windowAgents: list within cap → no folding, indices unchanged', () => {
  const list = agents(4)
  const w = windowAgents(list, 2, 10)
  expect(w.visible).toBe(list)
  expect(w.selectedInWindow).toBe(2)
  expect(w.hiddenAbove).toBe(0)
  expect(w.hiddenBelow).toBe(0)
})

test('windowAgents: selection at head → window pinned to top', () => {
  const w = windowAgents(agents(20), 0, 5)
  expect(w.visible.map(a => a.id)).toEqual([0, 1, 2, 3, 4])
  expect(w.selectedInWindow).toBe(0)
  expect(w.hiddenAbove).toBe(0)
  expect(w.hiddenBelow).toBe(15)
})

test('windowAgents: selection mid-list → window centered, both sides folded', () => {
  const w = windowAgents(agents(20), 10, 5)
  expect(w.visible.map(a => a.id)).toEqual([8, 9, 10, 11, 12])
  expect(w.selectedInWindow).toBe(2)
  expect(w.hiddenAbove).toBe(8)
  expect(w.hiddenBelow).toBe(7)
})

test('windowAgents: selection at tail → window pinned to bottom', () => {
  const w = windowAgents(agents(20), 19, 5)
  expect(w.visible.map(a => a.id)).toEqual([15, 16, 17, 18, 19])
  expect(w.selectedInWindow).toBe(4)
  expect(w.hiddenAbove).toBe(15)
  expect(w.hiddenBelow).toBe(0)
})

test('windowAgents: maxVisible < 1 degenerates to a single row', () => {
  const w = windowAgents(agents(5), 3, 0)
  expect(w.visible.map(a => a.id)).toEqual([3])
  expect(w.selectedInWindow).toBe(0)
})

test('windowAgents: default cap is MAX_VISIBLE_AGENTS', () => {
  const w = windowAgents(agents(MAX_VISIBLE_AGENTS + 5), 0)
  expect(w.visible).toHaveLength(MAX_VISIBLE_AGENTS)
})

test('routeWorkflowDetailKey normal mode: navigation + kill + back', () => {
  expect(routeWorkflowDetailKey('up', 'normal')).toBe('moveUp')
  expect(routeWorkflowDetailKey('down', 'normal')).toBe('moveDown')
  expect(routeWorkflowDetailKey('K', 'normal')).toBe('killWorkflow')
  expect(routeWorkflowDetailKey('left', 'normal')).toBe('back')
  // x flows through the configurable taskDetail:kill binding, not this router
  expect(routeWorkflowDetailKey('x', 'normal')).toBeNull()
  expect(routeWorkflowDetailKey('k', 'normal')).toBeNull()
  expect(routeWorkflowDetailKey('q', 'normal')).toBeNull()
})

test('routeWorkflowDetailKey confirm mode: only y/n/Enter/Esc respond, navigation swallowed', () => {
  expect(routeWorkflowDetailKey('y', 'confirm')).toBe('confirmYes')
  expect(routeWorkflowDetailKey('Y', 'confirm')).toBe('confirmYes')
  expect(routeWorkflowDetailKey('return', 'confirm')).toBe('confirmYes')
  expect(routeWorkflowDetailKey('n', 'confirm')).toBe('confirmNo')
  expect(routeWorkflowDetailKey('N', 'confirm')).toBe('confirmNo')
  expect(routeWorkflowDetailKey('escape', 'confirm')).toBe('confirmNo')
  expect(routeWorkflowDetailKey('up', 'confirm')).toBeNull()
  expect(routeWorkflowDetailKey('down', 'confirm')).toBeNull()
  expect(routeWorkflowDetailKey('K', 'confirm')).toBeNull()
  expect(routeWorkflowDetailKey('left', 'confirm')).toBeNull()
})

test('routeWorkflowDetailKey: Enter/→ drill into the selected agent', () => {
  // Same gesture as the /workflows panel — both surfaces render the same run,
  // so their navigation must not disagree.
  expect(routeWorkflowDetailKey('return', 'normal')).toBe('openAgent')
  expect(routeWorkflowDetailKey('right', 'normal')).toBe('openAgent')
})

test('routeWorkflowDetailKey: confirm mode still swallows →, and Enter confirms', () => {
  // Enter must not both confirm a kill and open an agent.
  expect(routeWorkflowDetailKey('return', 'confirm')).toBe('confirmYes')
  expect(routeWorkflowDetailKey('right', 'confirm')).toBeNull()
})
