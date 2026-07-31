import { describe, expect, test } from 'bun:test'
import {
  DIAMOND_FILLED,
  DIAMOND_OPEN,
  GEAR_ICON,
} from '../../constants/figures.js'
import {
  getPillLabel,
  pillNeedsCta,
  WORKFLOW_SUMMARY_MAX_COLS,
} from '../pillLabel.js'
import type { BackgroundTaskState } from '../types.js'

/**
 * Pill labels only ever read a handful of fields off each task, so the fixtures
 * stay minimal and are cast rather than fully constructed (test-only cast per
 * the repo's typing rules).
 */
function task(fields: Record<string, unknown>): BackgroundTaskState {
  return {
    id: 't',
    status: 'running',
    description: 'd',
    startTime: 0,
    ...fields,
  } as unknown as BackgroundTaskState
}

const workflow = (fields: Record<string, unknown> = {}): BackgroundTaskState =>
  task({
    type: 'local_workflow',
    runId: 'r1',
    workflowName: 'spec',
    workflowFile: '',
    ...fields,
  })

describe('getPillLabel', () => {
  test('shells and monitors are counted separately', () => {
    expect(
      getPillLabel([
        task({ type: 'local_bash' }),
        task({ type: 'local_bash' }),
        task({ type: 'local_bash', kind: 'monitor' }),
      ]),
    ).toBe('2 shells, 1 monitor')
  })

  test('a single shell is singularized', () => {
    expect(getPillLabel([task({ type: 'local_bash' })])).toBe('1 shell')
  })

  test('local agents are counted', () => {
    expect(
      getPillLabel([
        task({ type: 'local_agent' }),
        task({ type: 'local_agent' }),
      ]),
    ).toBe('2 local agents')
  })

  test('ultraplan phases pick their own diamond', () => {
    expect(
      getPillLabel([
        task({
          type: 'remote_agent',
          isUltraplan: true,
          ultraplanPhase: 'plan_ready',
        }),
      ]),
    ).toBe(`${DIAMOND_FILLED} ultraplan ready`)
    expect(
      getPillLabel([
        task({
          type: 'remote_agent',
          isUltraplan: true,
          ultraplanPhase: 'needs_input',
        }),
      ]),
    ).toBe(`${DIAMOND_OPEN} ultraplan needs your input`)
  })

  test('mixed task types fall back to a generic count', () => {
    expect(
      getPillLabel([
        task({ type: 'local_bash' }),
        task({ type: 'local_agent' }),
      ]),
    ).toBe('2 background tasks')
  })

  test('a single workflow names itself and its live summary', () => {
    expect(
      getPillLabel([workflow({ summary: 'review (2/4) · 3 agents' })]),
    ).toBe(`${GEAR_ICON} spec · review (2/4) · 3 agents`)
  })

  test('a workflow with no summary yet shows just the name', () => {
    expect(getPillLabel([workflow()])).toBe(`${GEAR_ICON} spec`)
  })

  test('an over-long summary is truncated to the column budget', () => {
    const summary = 'a'.repeat(WORKFLOW_SUMMARY_MAX_COLS + 25)
    const label = getPillLabel([workflow({ summary })])
    expect(label.startsWith(`${GEAR_ICON} spec · `)).toBe(true)
    const detail = label.slice(`${GEAR_ICON} spec · `.length)
    expect(detail.length).toBe(WORKFLOW_SUMMARY_MAX_COLS)
    expect(detail.endsWith('…')).toBe(true)
  })

  test('a summary within budget is left untouched', () => {
    const summary = 'x'.repeat(WORKFLOW_SUMMARY_MAX_COLS)
    expect(getPillLabel([workflow({ summary })])).toBe(
      `${GEAR_ICON} spec · ${summary}`,
    )
  })

  test('more than one workflow keeps the plain count', () => {
    expect(
      getPillLabel([
        workflow({ summary: 'review (2/4)' }),
        workflow({ workflowName: 'audit', summary: 'scan (1/3)' }),
      ]),
    ).toBe('2 background workflows')
  })

  test('monitors and dreaming keep their labels', () => {
    expect(getPillLabel([task({ type: 'monitor_mcp' })])).toBe('1 monitor')
    expect(getPillLabel([task({ type: 'dream' })])).toBe('dreaming')
  })
})

describe('pillNeedsCta', () => {
  test('only a lone ultraplan session with a phase gets the CTA', () => {
    expect(
      pillNeedsCta([
        task({
          type: 'remote_agent',
          isUltraplan: true,
          ultraplanPhase: 'plan_ready',
        }),
      ]),
    ).toBe(true)
    expect(
      pillNeedsCta([task({ type: 'remote_agent', isUltraplan: true })]),
    ).toBe(false)
    expect(pillNeedsCta([workflow({ summary: 'review (2/4)' })])).toBe(false)
    expect(pillNeedsCta([])).toBe(false)
  })
})
