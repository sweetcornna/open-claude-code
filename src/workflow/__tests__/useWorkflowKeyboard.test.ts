import { expect, test } from 'bun:test'
import {
  focusColumnLeftOf,
  focusColumnRightOf,
  routeWorkflowKey,
} from '../panel/useWorkflowKeyboard.js'

test('Tab → nextPane；Shift+Tab → prevPane', () => {
  expect(routeWorkflowKey('', { tab: true })).toBe('nextPane')
  expect(routeWorkflowKey('', { tab: true, shift: true })).toBe('prevPane')
})

test('[ / ] switch workflow runs independently from pane focus', () => {
  expect(routeWorkflowKey('[', {})).toBe('prevRun')
  expect(routeWorkflowKey(']', {})).toBe('nextRun')
})

test('q / Esc → quit', () => {
  expect(routeWorkflowKey('q', {})).toBe('quit')
  expect(routeWorkflowKey('', { escape: true })).toBe('quit')
})

test('x → cancelTarget；k/K have no workflow-kill special case', () => {
  expect(routeWorkflowKey('x', {})).toBe('cancelTarget')
  expect(routeWorkflowKey('k', {})).toBeNull()
  expect(routeWorkflowKey('K', {})).toBeNull()
  expect(routeWorkflowKey('r', {})).toBe('resume')
  expect(routeWorkflowKey('n', {})).toBe('newRun')
})

test('confirm mode: y/Enter → confirmYes; n/Esc/q → confirmNo; other keys → null', () => {
  expect(routeWorkflowKey('y', {}, 'confirm')).toBe('confirmYes')
  expect(routeWorkflowKey('Y', {}, 'confirm')).toBe('confirmYes')
  expect(routeWorkflowKey('', { return: true }, 'confirm')).toBe('confirmYes')
  expect(routeWorkflowKey('n', {}, 'confirm')).toBe('confirmNo')
  expect(routeWorkflowKey('N', {}, 'confirm')).toBe('confirmNo')
  expect(routeWorkflowKey('', { escape: true }, 'confirm')).toBe('confirmNo')
  expect(routeWorkflowKey('q', {}, 'confirm')).toBe('confirmNo')
  // confirm mode swallows navigation/edit keys, preventing accidental triggers
  expect(routeWorkflowKey('x', {}, 'confirm')).toBeNull()
  expect(routeWorkflowKey('', { tab: true }, 'confirm')).toBeNull()
  expect(routeWorkflowKey('', { upArrow: true }, 'confirm')).toBeNull()
})

test('←/→ switch pane; ↑/↓ move the focused selection; PageUp/PageDown scroll detail', () => {
  expect(routeWorkflowKey('', { leftArrow: true })).toBe('focusLeft')
  expect(routeWorkflowKey('', { rightArrow: true })).toBe('focusRight')
  expect(routeWorkflowKey('', { upArrow: true })).toBe('moveUp')
  expect(routeWorkflowKey('', { downArrow: true })).toBe('moveDown')
  expect(routeWorkflowKey('', { pageUp: true })).toBe('pageUp')
  expect(routeWorkflowKey('', { pageDown: true })).toBe('pageDown')
})

test('unrelated input → null', () => {
  expect(routeWorkflowKey('z', {})).toBeNull()
  expect(routeWorkflowKey('', {})).toBeNull()
})

test('Enter → openDetail; f → cycleStatusFilter', () => {
  expect(routeWorkflowKey('', { return: true })).toBe('openDetail')
  expect(routeWorkflowKey('f', {})).toBe('cycleStatusFilter')
})

test('confirm mode swallows the detail/filter keys', () => {
  // Enter is confirmYes inside a kill dialog — it must never also drill into
  // an agent, and f must not silently re-filter the list underneath.
  expect(routeWorkflowKey('', { return: true }, 'confirm')).toBe('confirmYes')
  expect(routeWorkflowKey('f', {}, 'confirm')).toBeNull()
})

test('focusColumnLeftOf: steps out one level and stops at phases', () => {
  // Arrows must never close the panel — that is Esc's job.
  expect(focusColumnLeftOf('detail')).toBe('agents')
  expect(focusColumnLeftOf('agents')).toBe('phases')
  expect(focusColumnLeftOf('phases')).toBe('phases')
})

test('focusColumnRightOf: steps in one level and stops at detail', () => {
  expect(focusColumnRightOf('phases')).toBe('agents')
  expect(focusColumnRightOf('agents')).toBe('detail')
  expect(focusColumnRightOf('detail')).toBe('detail')
})
