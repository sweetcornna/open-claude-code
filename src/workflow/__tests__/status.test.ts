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
  isRetryBackoffActive,
  isRunReaped,
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

// run_done reaps agents that were still running by stamping resultKind 'dead' with a
// `run-*` reason. Rendering those as ✗ error told a user who had just pressed K that
// their own kill had failed.
test('agentVisual: reaped with the run → ⊘ subtle, not a red ✗', () => {
  for (const reason of ['run-killed', 'run-failed', 'run-ended']) {
    const a: AgentProgress = {
      id: 1,
      status: 'done',
      resultKind: 'dead',
      failureReason: reason,
    }
    expect(agentVisual(a)).toEqual({ mark: '⊘', color: 'subtle' })
    expect(agentStatusText(a)).toBe('stopped')
    expect(isRunReaped(a)).toBe(true)
  }
})

test('isRunReaped: a genuine engine failure is still a failure', () => {
  const dead: AgentProgress = {
    id: 1,
    status: 'done',
    resultKind: 'dead',
    failureReason: 'prompt-too-long',
  }
  expect(isRunReaped(dead)).toBe(false)
  expect(agentVisual(dead)).toEqual({ mark: '✗', color: 'error' })
  expect(agentStatusText(dead)).toBe('failed')
  // Reaped-ness only counts on a dead row — a reap reason can never reach an ok
  // result, but the guard keeps the predicate honest if it ever does.
  expect(
    isRunReaped({
      id: 1,
      status: 'done',
      resultKind: 'ok',
      failureReason: 'run-killed',
    }),
  ).toBe(false)
  expect(isRunReaped({ id: 1, status: 'running' })).toBe(false)
})

// The reason this is an explicit set and not a `startsWith('run-')` test: the engine's
// own vocabulary contains 'runagent-threw', which is a real crash. A prefix check that
// drifts one character quietly relabels crashes as "the user stopped it" — the one
// direction this must never fail in.
test('isRunReaped: engine reasons that merely start like a reap reason are not reaped', () => {
  for (const reason of ['runagent-threw', 'run', 'runner-died', 'run-']) {
    const a: AgentProgress = {
      id: 1,
      status: 'done',
      resultKind: 'dead',
      failureReason: reason,
    }
    expect(isRunReaped(a)).toBe(false)
    expect(agentVisual(a)).toEqual({ mark: '✗', color: 'error' })
    expect(agentStatusText(a)).toBe('failed')
  }
})

// The store announces the start of a backoff (agent_retry) and never its end, so the
// UI has to decide "still waiting" from the clock. Both the list's ↻ marker and the
// detail pane's copy read this, so they cannot disagree.
test('isRetryBackoffActive: true only inside retryingSince + retryDelayMs', () => {
  const retrying: AgentProgress = {
    id: 1,
    status: 'running',
    retryCount: 2,
    retryingSince: 10_000,
    retryDelayMs: 5_000,
  }
  expect(isRetryBackoffActive(retrying, 10_000)).toBe(true)
  expect(isRetryBackoffActive(retrying, 14_999)).toBe(true)
  // Exactly at the end the backoff is over, not still pending.
  expect(isRetryBackoffActive(retrying, 15_000)).toBe(false)
  expect(isRetryBackoffActive(retrying, 99_000)).toBe(false)
  // A zero / missing delay means the engine retried immediately.
  expect(isRetryBackoffActive({ ...retrying, retryDelayMs: 0 }, 10_000)).toBe(
    false,
  )
  expect(
    isRetryBackoffActive({ ...retrying, retryDelayMs: undefined }, 10_000),
  ).toBe(false)
  // agent_done leaves retryingSince in place; a finished agent is never waiting.
  expect(isRetryBackoffActive({ ...retrying, status: 'done' }, 12_000)).toBe(
    false,
  )
  expect(isRetryBackoffActive({ id: 2, status: 'running' }, 12_000)).toBe(false)
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
