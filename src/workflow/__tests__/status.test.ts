import { expect, test } from 'bun:test'
import type { AgentProgress, RunProgress } from '../progress/store.js'
import {
  STATUS_DOT,
  RUN_STATUS_COLOR,
  RUN_STATUS_TEXT,
  PHASE_MARK,
  PHASE_COLOR,
  agentVisual,
  agentStatusText,
  formatTokenCount,
  agentMetaText,
  shortModelName,
} from '../panel/status.js'

test('STATUS_DOT / RUN_STATUS_COLOR / RUN_STATUS_TEXT cover four run states', () => {
  const statuses: RunProgress['status'][] = [
    'running',
    'completed',
    'failed',
    'killed',
  ]
  for (const s of statuses) {
    expect(STATUS_DOT[s].length).toBeGreaterThan(0)
    expect(RUN_STATUS_COLOR[s]).toBeTruthy()
    expect(RUN_STATUS_TEXT[s].length).toBeGreaterThan(0)
  }
  expect(STATUS_DOT.running).toBe('●')
  expect(STATUS_DOT.completed).toBe('✓')
  expect(STATUS_DOT.failed).toBe('✗')
  expect(STATUS_DOT.killed).toBe('■')
  expect(RUN_STATUS_TEXT.completed).toBe('done')
  expect(RUN_STATUS_TEXT.running).toBe('running')
})

test('PHASE_MARK / PHASE_COLOR cover running/done/pending', () => {
  expect(PHASE_MARK.running).toBe('●')
  expect(PHASE_MARK.done).toBe('✓')
  expect(PHASE_MARK.pending).toBe('○')
  expect(PHASE_COLOR.pending).toBe('subtle')
})

test('agentVisual: running → ● warning', () => {
  const a: AgentProgress = { id: 1, status: 'running' }
  expect(agentVisual(a)).toEqual({ mark: '●', color: 'warning' })
})

test('agentVisual: done·ok → ✓ success (no longer carries outputShape suffix)', () => {
  const a: AgentProgress = {
    id: 1,
    status: 'done',
    resultKind: 'ok',
    outputShape: 'object',
  }
  expect(agentVisual(a)).toEqual({ mark: '✓', color: 'success' })
})

test('agentVisual: dead → ✗ error', () => {
  const a: AgentProgress = { id: 1, status: 'done', resultKind: 'dead' }
  expect(agentVisual(a)).toEqual({ mark: '✗', color: 'error' })
})

test('agentVisual: skipped → ⊘ subtle (not misread as ✓ success)', () => {
  const a: AgentProgress = { id: 1, status: 'done', resultKind: 'skipped' }
  expect(agentVisual(a)).toEqual({ mark: '⊘', color: 'subtle' })
})

test('formatTokenCount: <1000 original value, ≥1000 keeps 1 decimal + k', () => {
  expect(formatTokenCount(undefined)).toBe('0')
  expect(formatTokenCount(0)).toBe('0')
  expect(formatTokenCount(42)).toBe('42')
  expect(formatTokenCount(1000)).toBe('1.0k')
  expect(formatTokenCount(22900)).toBe('22.9k')
})

test('agentMetaText: model · Nk tok, tool count lives in the detail view', () => {
  const a: AgentProgress = {
    id: 1,
    status: 'done',
    model: 'glm-5.2',
    tokenCount: 22900,
    toolCount: 1,
  }
  // The per-row tool count moved into AgentDetail: at list width it squeezed
  // the label column, and the number is only actionable once you are already
  // looking at a single agent.
  expect(agentMetaText(a)).toBe('glm-5.2 · 22.9k tok')
})

test('agentMetaText: omits prefix when no model', () => {
  const a: AgentProgress = {
    id: 1,
    status: 'running',
    tokenCount: 500,
    toolCount: 2,
  }
  expect(agentMetaText(a)).toBe('500 tok')
})

test('agentMetaText: shortens the model id to keep the label column wide', () => {
  const a: AgentProgress = {
    id: 1,
    status: 'done',
    model: 'us.anthropic.claude-sonnet-5-20260101',
    tokenCount: 1000,
  }
  expect(agentMetaText(a)).toBe('sonnet-5 · 1.0k tok')
})

test('shortModelName: strips vendor prefix, claude- prefix and date stamp', () => {
  expect(shortModelName('claude-opus-5')).toBe('opus-5')
  expect(shortModelName('claude-haiku-4-5-20251001')).toBe('haiku-4-5')
  expect(shortModelName('us.anthropic.claude-sonnet-5')).toBe('sonnet-5')
  expect(shortModelName('claude-opus-5-20260101[1m]')).toBe('opus-5[1m]')
})

test('shortModelName: passes unrecognized ids through unchanged', () => {
  // Third-party models must stay identifiable — no prefix to strip.
  expect(shortModelName('glm-5.2')).toBe('glm-5.2')
  expect(shortModelName('deepseek-v3')).toBe('deepseek-v3')
})

test('agentStatusText: done splits by resultKind so a dead agent is never "done"', () => {
  const base: AgentProgress = { id: 1, status: 'done' }
  expect(agentStatusText({ ...base, status: 'running' })).toBe('running')
  expect(agentStatusText({ ...base, resultKind: 'ok' })).toBe('done')
  expect(agentStatusText({ ...base, resultKind: 'dead' })).toBe('failed')
  expect(agentStatusText({ ...base, resultKind: 'skipped' })).toBe('skipped')
})
