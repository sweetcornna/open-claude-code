// Feeds synthetic ProgressEvents through the real bus + store (both pure, no React) and
// asserts the bridge only reaches AppState on material transitions, and honours the
// trailing throttle. Time is injected, never slept on.
//
// Deliberately does NOT mock.module anything: the bridge takes its write side-effect and
// its clock as parameters, so the real progress store and the real updateTaskState both
// run unmocked (mock.module is process-global and would leak into sibling workflow tests).
import { describe, expect, test } from 'bun:test'
import type { AgentRunResult } from '@open-claude-code/workflow-engine'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../../Task.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import type { WorkflowTaskBindings } from '../ports.js'
import { createProgressBus } from '../progress/bus.js'
import { createProgressStoreFromBus } from '../progress/store.js'
import {
  formatPhaseLabel,
  formatRunSummary,
  installWorkflowTaskStateBridge,
  type WorkflowTaskProgress,
} from '../taskStateBridge.js'

const ok = (output: string): AgentRunResult => ({
  kind: 'ok',
  output,
  usage: { outputTokens: 1 },
})

/** Manual clock + timer queue: `advance` fires due timers in order, no real waiting. */
function makeFakeClock() {
  let current = 0
  let nextId = 1
  const timers: Array<{ id: number; at: number; fn: () => void }> = []
  return {
    clock: {
      now: () => current,
      schedule: (fn: () => void, ms: number) => {
        const id = nextId++
        timers.push({ id, at: current + ms, fn })
        return () => {
          const i = timers.findIndex(t => t.id === id)
          if (i >= 0) timers.splice(i, 1)
        }
      },
    },
    pendingCount: () => timers.length,
    advance(ms: number) {
      const target = current + ms
      for (;;) {
        const due = timers
          .filter(t => t.at <= target)
          .sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers.splice(timers.indexOf(due), 1)
        current = due.at
        due.fn()
      }
      current = target
    },
  }
}

function makeHarness(opts: { throttleMs?: number; bound?: boolean } = {}) {
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus)
  const writes: WorkflowTaskProgress[] = []
  const fake = makeFakeClock()
  const bindings: WorkflowTaskBindings = {
    getTaskIdForRun: () => (opts.bound === false ? undefined : 'task-1'),
    getSetAppStateForRun: () => (opts.bound === false ? undefined : () => {}),
  }
  const stop = installWorkflowTaskStateBridge(store, bindings, {
    write: p => writes.push(p),
    throttleMs: opts.throttleMs ?? 500,
    clock: fake.clock,
  })
  return { bus, store, writes, fake, stop }
}

describe('formatPhaseLabel', () => {
  test('uses declaredPhases for the index/total', () => {
    expect(
      formatPhaseLabel({
        declaredPhases: ['scan', 'review', 'fix', 'verify'],
        phases: [{ title: 'review', status: 'running' }],
        currentPhase: 'review',
        agents: [],
      }),
    ).toBe('review (2/4)')
  })

  test('falls back to observed phases when meta declared none', () => {
    expect(
      formatPhaseLabel({
        declaredPhases: [],
        phases: [
          { title: 'a', status: 'done' },
          { title: 'b', status: 'running' },
        ],
        currentPhase: 'b',
        agents: [],
      }),
    ).toBe('b (2/2)')
  })

  test('keeps the last running phase after phase_done clears currentPhase', () => {
    expect(
      formatPhaseLabel({
        declaredPhases: ['a', 'b'],
        phases: [
          { title: 'a', status: 'done' },
          { title: 'b', status: 'running' },
        ],
        currentPhase: null,
        agents: [],
      }),
    ).toBe('b (2/2)')
  })

  test('returns null when nothing is in flight', () => {
    expect(
      formatPhaseLabel({
        declaredPhases: [],
        phases: [],
        currentPhase: null,
        agents: [],
      }),
    ).toBeNull()
  })
})

describe('formatRunSummary', () => {
  test('combines phase and running agent count', () => {
    expect(
      formatRunSummary({
        declaredPhases: ['scan', 'review', 'fix', 'verify'],
        phases: [{ title: 'review', status: 'running' }],
        currentPhase: 'review',
        agents: [
          { id: 1, status: 'running' },
          { id: 2, status: 'running' },
          { id: 3, status: 'running' },
          { id: 4, status: 'done' },
        ],
      }),
    ).toBe('review (2/4) · 3 agents')
  })

  test('singularizes a lone agent and omits the phase when absent', () => {
    expect(
      formatRunSummary({
        declaredPhases: [],
        phases: [],
        currentPhase: null,
        agents: [{ id: 1, status: 'running' }],
      }),
    ).toBe('1 agent')
  })

  test('falls back to "starting" before any phase or agent exists', () => {
    expect(
      formatRunSummary({
        declaredPhases: [],
        phases: [],
        currentPhase: null,
        agents: [],
      }),
    ).toBe('starting')
  })
})

describe('installWorkflowTaskStateBridge', () => {
  test('writes once immediately when a run starts', () => {
    const { bus, writes, stop } = makeHarness()
    bus.emit({
      type: 'run_started',
      runId: 'r1',
      workflowName: 'w',
      meta: null,
    })
    expect(writes).toEqual([
      { runId: 'r1', summary: 'starting', agentCount: 0 },
    ])
    stop()
  })

  test('token/tool ticks are not material — no write, no timer', () => {
    const { bus, writes, fake, stop } = makeHarness()
    bus.emit({
      type: 'run_started',
      runId: 'r1',
      workflowName: 'w',
      meta: null,
    })
    bus.emit({
      type: 'agent_started',
      runId: 'r1',
      agentId: 1,
      label: 'a',
      phase: 'scan',
    })
    fake.advance(1000)
    expect(writes.length).toBe(2)

    for (let i = 1; i <= 20; i++) {
      bus.emit({
        type: 'agent_progress',
        runId: 'r1',
        agentId: 1,
        tokenCount: i * 100,
        toolCount: i,
      })
    }
    expect(writes.length).toBe(2)
    expect(fake.pendingCount()).toBe(0)
    fake.advance(5000)
    expect(writes.length).toBe(2)
    stop()
  })

  test('collapses a burst of material transitions into one trailing write', () => {
    const { bus, writes, fake, stop } = makeHarness({ throttleMs: 500 })
    bus.emit({
      type: 'run_started',
      runId: 'r1',
      workflowName: 'w',
      meta: {
        name: 'w',
        description: 'd',
        phases: [
          { title: 'scan' },
          { title: 'review' },
          { title: 'fix' },
          { title: 'verify' },
        ],
      },
    })
    expect(writes.length).toBe(1) // leading edge

    // Burst inside the window: phase + three parallel agents.
    bus.emit({ type: 'phase_started', runId: 'r1', phase: 'review' })
    for (const agentId of [1, 2, 3]) {
      bus.emit({
        type: 'agent_started',
        runId: 'r1',
        agentId,
        label: `a${agentId}`,
        phase: 'review',
      })
    }
    // Still throttled — one pending trailing write, nothing committed yet.
    expect(writes.length).toBe(1)
    expect(fake.pendingCount()).toBe(1)

    fake.advance(500)
    expect(writes.length).toBe(2)
    // Trailing edge carries the newest state, not the state at schedule time.
    expect(writes[1]).toEqual({
      runId: 'r1',
      summary: 'review (2/4) · 3 agents',
      agentCount: 3,
    })
    stop()
  })

  test('material changes spaced beyond the window write immediately', () => {
    const { bus, writes, fake, stop } = makeHarness({ throttleMs: 500 })
    bus.emit({
      type: 'run_started',
      runId: 'r1',
      workflowName: 'w',
      meta: null,
    })
    expect(writes.length).toBe(1)

    fake.advance(600)
    bus.emit({
      type: 'agent_started',
      runId: 'r1',
      agentId: 1,
      label: 'a',
      phase: 'scan',
    })
    expect(writes.length).toBe(2)
    expect(fake.pendingCount()).toBe(0)

    fake.advance(600)
    bus.emit({
      type: 'agent_done',
      runId: 'r1',
      agentId: 1,
      label: 'a',
      phase: 'scan',
      result: ok('x'),
    })
    expect(writes.length).toBe(3)
    expect(writes[2]!.summary).toBe('scan (1/1)')
    stop()
  })

  test('terminal runs are left to the task registrar (no write, timers dropped)', () => {
    const { bus, writes, fake, stop } = makeHarness({ throttleMs: 500 })
    bus.emit({
      type: 'run_started',
      runId: 'r1',
      workflowName: 'w',
      meta: null,
    })
    bus.emit({ type: 'phase_started', runId: 'r1', phase: 'scan' })
    expect(fake.pendingCount()).toBe(1)

    bus.emit({ type: 'run_done', runId: 'r1', status: 'completed' })
    expect(fake.pendingCount()).toBe(0)
    const before = writes.length
    fake.advance(5000)
    expect(writes.length).toBe(before)
    stop()
  })

  test('tracks concurrent runs independently', () => {
    const { bus, writes, fake, stop } = makeHarness({ throttleMs: 500 })
    bus.emit({
      type: 'run_started',
      runId: 'r1',
      workflowName: 'a',
      meta: null,
    })
    bus.emit({
      type: 'run_started',
      runId: 'r2',
      workflowName: 'b',
      meta: null,
    })
    expect(writes.map(w => w.runId).sort()).toEqual(['r1', 'r2'])

    bus.emit({ type: 'phase_started', runId: 'r1', phase: 'scan' })
    bus.emit({ type: 'phase_started', runId: 'r2', phase: 'build' })
    expect(fake.pendingCount()).toBe(2)
    fake.advance(500)
    expect(writes.length).toBe(4)
    expect(writes[2]!.runId).not.toBe(writes[3]!.runId)
    stop()
  })

  test('unsubscribe cancels pending trailing writes', () => {
    const { bus, writes, fake, stop } = makeHarness({ throttleMs: 500 })
    bus.emit({
      type: 'run_started',
      runId: 'r1',
      workflowName: 'w',
      meta: null,
    })
    bus.emit({ type: 'phase_started', runId: 'r1', phase: 'scan' })
    const before = writes.length
    stop()
    fake.advance(5000)
    expect(writes.length).toBe(before)

    bus.emit({ type: 'phase_started', runId: 'r1', phase: 'next' })
    fake.advance(5000)
    expect(writes.length).toBe(before)
  })

  test('is inert when the run has no task binding (headless)', () => {
    const bus = createProgressBus()
    const store = createProgressStoreFromBus(bus)
    const fake = makeFakeClock()
    let setAppStateCalls = 0
    const bindings: WorkflowTaskBindings = {
      getTaskIdForRun: () => undefined,
      getSetAppStateForRun: () => () => {
        setAppStateCalls++
      },
    }
    // Default writer (real updateTaskState path), no injected spy.
    const stop = installWorkflowTaskStateBridge(store, bindings, {
      throttleMs: 500,
      clock: fake.clock,
    })
    bus.emit({
      type: 'run_started',
      runId: 'r1',
      workflowName: 'w',
      meta: null,
    })
    bus.emit({ type: 'phase_started', runId: 'r1', phase: 'scan' })
    fake.advance(1000)
    expect(setAppStateCalls).toBe(0)
    stop()
  })

  test('default writer patches summary/agentCount onto the bound task and skips no-ops', () => {
    const bus = createProgressBus()
    const store = createProgressStoreFromBus(bus)
    const fake = makeFakeClock()

    const task: LocalWorkflowTaskState = {
      id: 'task-1',
      type: 'local_workflow',
      status: 'running',
      description: 'demo',
      startTime: 0,
      runId: 'r1',
      workflowName: 'demo',
      workflowFile: '',
    } as unknown as LocalWorkflowTaskState
    let state = { tasks: { 'task-1': task } } as unknown as AppState
    let commits = 0
    const setAppState: SetAppState = updater => {
      const next = updater(state)
      if (next !== state) commits++
      state = next
    }
    const bindings: WorkflowTaskBindings = {
      getTaskIdForRun: () => 'task-1',
      getSetAppStateForRun: () => setAppState,
    }
    const stop = installWorkflowTaskStateBridge(store, bindings, {
      throttleMs: 500,
      clock: fake.clock,
    })

    bus.emit({
      type: 'run_started',
      runId: 'r1',
      workflowName: 'demo',
      meta: null,
    })
    bus.emit({ type: 'phase_started', runId: 'r1', phase: 'scan' })
    bus.emit({
      type: 'agent_started',
      runId: 'r1',
      agentId: 1,
      label: 'a',
      phase: 'scan',
    })
    fake.advance(500)

    const updated = (state.tasks as Record<string, LocalWorkflowTaskState>)[
      'task-1'
    ]!
    expect(updated.summary).toBe('scan (1/1) · 1 agent')
    expect(updated.agentCount).toBe(1)
    expect(commits).toBe(2) // leading 'starting' write + trailing burst write

    // Re-emitting the identical material state must not commit again.
    const commitsBefore = commits
    fake.advance(600)
    bus.emit({ type: 'phase_started', runId: 'r1', phase: 'scan' })
    fake.advance(600)
    expect(commits).toBe(commitsBefore)
    stop()
  })
})
