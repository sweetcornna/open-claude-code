// React-free tests for the legacy WorkflowDetailDialog key projection.

import { expect, test } from 'bun:test'
import { routeWorkflowDetailKey } from '../workflowDetailData.js'

test('routeWorkflowDetailKey normal mode: navigation + back, with no k/K kill special case', () => {
  expect(routeWorkflowDetailKey('up', 'normal')).toBe('moveUp')
  expect(routeWorkflowDetailKey('down', 'normal')).toBe('moveDown')
  expect(routeWorkflowDetailKey('left', 'normal')).toBe('back')
  expect(routeWorkflowDetailKey('x', 'normal')).toBeNull()
  expect(routeWorkflowDetailKey('k', 'normal')).toBeNull()
  expect(routeWorkflowDetailKey('K', 'normal')).toBeNull()
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
