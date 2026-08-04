import { expect, test } from 'bun:test'
import {
  focusColumnLeftOf,
  focusColumnRightOf,
  routeWorkflowKey,
} from '../panel/useWorkflowKeyboard.js'

test('Tab → nextTab；Shift+Tab → prevTab', () => {
  expect(routeWorkflowKey('', { tab: true })).toBe('nextTab')
  expect(routeWorkflowKey('', { tab: true, shift: true })).toBe('prevTab')
})

test('q / Esc → quit', () => {
  expect(routeWorkflowKey('q', {})).toBe('quit')
  expect(routeWorkflowKey('', { escape: true })).toBe('quit')
})

test('x → killAgent；K → killWorkflow；r → resume；n → newRun', () => {
  expect(routeWorkflowKey('x', {})).toBe('killAgent')
  expect(routeWorkflowKey('K', {})).toBe('killWorkflow')
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

test('←/→ switch focus column; ↑/↓ move within column', () => {
  expect(routeWorkflowKey('', { leftArrow: true })).toBe('focusLeft')
  expect(routeWorkflowKey('', { rightArrow: true })).toBe('focusRight')
  expect(routeWorkflowKey('', { upArrow: true })).toBe('moveUp')
  expect(routeWorkflowKey('', { downArrow: true })).toBe('moveDown')
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
