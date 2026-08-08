import { expect, test } from 'bun:test'
import { createProgressBus, type ProgressBus } from '../progress/bus.js'
import {
  OUTPUT_PREVIEW_MAX,
  buildOutputPreview,
  createProgressStoreFromBus,
  type RunProgress,
} from '../progress/store.js'
import type { AgentRunResult } from '@open-claude-code/workflow-engine'

const ok = (o: string): AgentRunResult => ({
  kind: 'ok',
  output: o,
  usage: { outputTokens: 1 },
})

function newStore() {
  const bus: ProgressBus = createProgressBus()
  return { bus, store: createProgressStoreFromBus(bus) }
}

test('run_started creates entry; phase_started/done updates phases', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'phase_started', runId: 'r1', phase: 'A' })
  bus.emit({ type: 'phase_started', runId: 'r1', phase: 'B' })
  bus.emit({ type: 'phase_done', runId: 'r1', phase: 'A' })
  const r = store.get('r1')!
  expect(r.phases.map(p => [p.title, p.status])).toEqual([
    ['A', 'done'],
    ['B', 'running'],
  ])
  expect(r.currentPhase).toBe('B')
})

test('concurrent agent_done correlates by agentId precisely (regression of old LIFO race)', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({
    type: 'agent_started',
    runId: 'r1',
    agentId: 0,
    label: 'a',
    phase: 'A',
  })
  bus.emit({
    type: 'agent_started',
    runId: 'r1',
    agentId: 1,
    label: 'b',
    phase: 'A',
  })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 1,
    label: 'b',
    phase: 'A',
    result: ok('b-out'),
  })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 0,
    label: 'a',
    phase: 'A',
    result: ok('a-out'),
  })
  const agents = store.get('r1')!.agents
  expect(agents.find(x => x.id === 0)?.status).toBe('done')
  expect(agents.find(x => x.id === 1)?.status).toBe('done')
  expect(agents.find(x => x.id === 0)?.label).toBe('a')
  expect(agents.find(x => x.id === 1)?.label).toBe('b')
})

test('journal hit (agent_done without started) backfills replay execution and activity', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 7,
    label: 'c',
    phase: 'A',
    result: ok('c'),
    execution: 'replayed',
  })
  const a = store.get('r1')!.agents.find(x => x.id === 7)!
  expect(a.status).toBe('done')
  expect(a.execution).toBe('replayed')
  expect(typeof a.lastActivityAt).toBe('number')
})

test('run_done terminal state + list sort + subscribe notification', () => {
  const { bus, store } = newStore()
  let calls = 0
  store.subscribe(() => calls++)
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({
    type: 'run_done',
    runId: 'r1',
    status: 'completed',
    returnValue: 42,
  })
  const r = store.get('r1')!
  expect(r.status).toBe('completed')
  expect(r.returnValue).toBe(42)
  expect(store.list().map(x => x.runId)).toEqual(['r1'])
  expect(calls).toBe(2)
})

test('run_done failed terminal state records error', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r2', workflowName: 'w', meta: null })
  bus.emit({ type: 'run_done', runId: 'r2', status: 'failed', error: 'boom' })
  const r = store.get('r2')!
  expect(r.status).toBe('failed')
  expect(r.error).toBe('boom')
})

test('latest wrapper task and instance identity survives terminal reduction', () => {
  const { bus, store } = newStore()
  bus.emit({
    type: 'run_started',
    runId: 'r-identity',
    taskId: 'w-wrapper',
    instanceId: 7,
    workflowName: 'w',
    meta: null,
  })
  bus.emit({
    type: 'run_done',
    runId: 'r-identity',
    taskId: 'w-wrapper',
    instanceId: 7,
    workflowName: 'w',
    status: 'completed',
  })

  expect(store.get('r-identity')).toMatchObject({
    taskId: 'w-wrapper',
    instanceId: 7,
    status: 'completed',
  })
})

test('run_started on resume resets stale instance agents, phases, output, error, and timing', () => {
  const { bus, store } = newStore()
  bus.emit({
    type: 'run_started',
    runId: 'r1',
    workflowName: 'old',
    meta: null,
  })
  bus.emit({ type: 'phase_started', runId: 'r1', phase: 'Old phase' })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0, label: 'old' })
  bus.emit({
    type: 'run_done',
    runId: 'r1',
    status: 'failed',
    returnValue: 'old result',
    error: 'old error',
  })
  store.get('r1')!.startedAt = 1

  bus.emit({
    type: 'run_started',
    runId: 'r1',
    workflowName: 'resumed',
    meta: { name: 'resumed', description: 'new', phases: [{ title: 'New' }] },
  })

  const resumed = store.get('r1')!
  expect(resumed.status).toBe('running')
  expect(resumed.workflowName).toBe('resumed')
  expect(resumed.agents).toEqual([])
  expect(resumed.phases).toEqual([])
  expect(resumed.declaredPhases).toEqual(['New'])
  expect(resumed.returnValue).toBeUndefined()
  expect(resumed.error).toBeUndefined()
  expect(resumed.startedAt).toBeGreaterThan(1)
})

test('remove forgets terminal progress and publishes a new snapshot', () => {
  const { bus, store } = newStore()
  let changes = 0
  store.subscribe(() => changes++)
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'run_done', runId: 'r1', status: 'completed' })
  const beforeRemove = changes

  store.remove('r1')

  expect(store.get('r1')).toBeUndefined()
  expect(store.list()).toEqual([])
  expect(changes).toBe(beforeRemove + 1)
})

test('log event does not trigger notify', () => {
  const { bus, store } = newStore()
  let calls = 0
  store.subscribe(() => calls++)
  bus.emit({ type: 'run_started', runId: 'r3', workflowName: 'w', meta: null })
  const before = calls
  bus.emit({ type: 'log', runId: 'r3', message: 'hi' })
  expect(calls).toBe(before) // log should not trigger notify
})

test('run_started persists declaredPhases (from meta.phases, order preserved)', () => {
  const { bus, store } = newStore()
  bus.emit({
    type: 'run_started',
    runId: 'r1',
    workflowName: 'w',
    meta: {
      name: 'w',
      description: 'd',
      phases: [{ title: 'Find' }, { title: 'Review' }, { title: 'Verify' }],
    },
  })
  expect(store.get('r1')!.declaredPhases).toEqual(['Find', 'Review', 'Verify'])
})

test('run_started meta is null → declaredPhases = []', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  expect(store.get('r1')!.declaredPhases).toEqual([])
})

test('agent_done persists outputShape (ok·object / ok·text / dead none)', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0, phase: 'A' })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 1, phase: 'A' })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 2, phase: 'A' })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 0,
    phase: 'A',
    result: { kind: 'ok', output: { x: 1 }, usage: { outputTokens: 1 } },
  })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 1,
    phase: 'A',
    result: { kind: 'ok', output: 'hi', usage: { outputTokens: 1 } },
  })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 2,
    phase: 'A',
    result: { kind: 'dead' },
  })
  const agents = store.get('r1')!.agents
  expect(agents.find(a => a.id === 0)?.outputShape).toBe('object')
  expect(agents.find(a => a.id === 1)?.outputShape).toBe('text')
  expect(agents.find(a => a.id === 2)?.outputShape).toBeUndefined()
})

test('agent_progress real-time updates token/tool (correlated by agentId)', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({
    type: 'agent_started',
    runId: 'r1',
    agentId: 0,
    label: 'a',
    phase: 'A',
  })
  bus.emit({
    type: 'agent_progress',
    runId: 'r1',
    agentId: 0,
    tokenCount: 1200,
    toolCount: 2,
  })
  let a = store.get('r1')!.agents.find(x => x.id === 0)!
  expect(a.tokenCount).toBe(1200)
  expect(a.toolCount).toBe(2)
  bus.emit({
    type: 'agent_progress',
    runId: 'r1',
    agentId: 0,
    tokenCount: 2400,
    toolCount: 3,
  })
  a = store.get('r1')!.agents.find(x => x.id === 0)!
  expect(a.tokenCount).toBe(2400)
  expect(a.toolCount).toBe(3)
  expect(a.execution).toBe('live')
  expect(typeof a.lastActivityAt).toBe('number')
})

test('agent_done persists model/tokenCount/toolCount (ok variant)', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0, phase: 'A' })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 0,
    phase: 'A',
    result: {
      kind: 'ok',
      output: 'x',
      usage: { outputTokens: 5 },
      model: 'glm-5.2',
      tokenCount: 22900,
      toolCount: 1,
    },
  })
  const a = store.get('r1')!.agents.find(x => x.id === 0)!
  expect(a.model).toBe('glm-5.2')
  expect(a.tokenCount).toBe(22900)
  expect(a.toolCount).toBe(1)
})

// ---- hydrate: inject historical run from disk (cross-restart recovery) ----

test('hydrate injects new run → get hits + list includes it + notifies listener', () => {
  const { store } = newStore()
  let notified = 0
  store.subscribe(() => notified++)

  const historical: RunProgress = {
    runId: 'hist-1',
    workflowName: 'old-job',
    status: 'completed',
    phases: [],
    declaredPhases: [],
    currentPhase: null,
    agents: [],
    agentCount: 5,
    returnValue: { summary: 'past' },
    startedAt: 1,
    updatedAt: 2,
  }
  store.hydrate(historical)

  expect(store.get('hist-1')).toBe(historical)
  expect(store.list().map(r => r.runId)).toContain('hist-1')
  expect(notified).toBeGreaterThan(0)
})

test('hydrate existing runId → skip (memory first, not overwritten by disk)', () => {
  const { bus, store } = newStore()
  bus.emit({
    type: 'run_started',
    runId: 'r1',
    workflowName: 'live',
    meta: null,
  })

  const stale: RunProgress = {
    runId: 'r1',
    workflowName: 'STALE-SHOULD-NOT-WIN',
    status: 'completed',
    phases: [],
    declaredPhases: [],
    currentPhase: null,
    agents: [],
    agentCount: 0,
    startedAt: 1,
    updatedAt: 2,
  }
  store.hydrate(stale)

  const got = store.get('r1')!
  expect(got.workflowName).toBe('live')
  expect(got.status).toBe('running')
})

// ── data behind the agent detail view ──────────────────────────────────────

test('agent_done persists the dead reason/detail/retryable', () => {
  // Without these the detail view can only show an unexplained ✗ and the
  // user has to read the run journal by hand to find the cause.
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0, label: 'a' })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 0,
    result: {
      kind: 'dead',
      reason: 'prompt-too-long',
      detail: 'context window exceeded',
      retryable: false,
    },
  })
  const a = store.get('r1')!.agents[0]!
  expect(a.resultKind).toBe('dead')
  expect(a.failureReason).toBe('prompt-too-long')
  expect(a.failureDetail).toBe('context window exceeded')
  expect(a.retryable).toBe(false)
})

test('agent_done defaults a reason-less dead result to unknown', () => {
  // Old journals and third-party adapters may omit `reason`.
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0 })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 0,
    result: { kind: 'dead' },
  })
  expect(store.get('r1')!.agents[0]!.failureReason).toBe('unknown')
})

test('agent_done keeps a bounded output preview and the output token count', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0 })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 0,
    result: {
      kind: 'ok',
      output: { findings: ['a', 'b'] },
      usage: { outputTokens: 42 },
    },
  })
  const a = store.get('r1')!.agents[0]!
  expect(a.outputPreview).toBe('{"findings":["a","b"]}')
  expect(a.outputTokens).toBe(42)
  expect(a.outputShape).toBe('object')
})

test('buildOutputPreview truncates so a fan-out run cannot pin every output', () => {
  const long = 'x'.repeat(OUTPUT_PREVIEW_MAX + 500)
  const preview = buildOutputPreview(long)
  expect(preview.length).toBe(OUTPUT_PREVIEW_MAX + 1) // + the … marker
  expect(preview.endsWith('…')).toBe(true)
})

test('buildOutputPreview degrades instead of throwing on unserializable output', () => {
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  expect(() => buildOutputPreview(cyclic)).not.toThrow()
})

test('agent timestamps: startedAt on start, endedAt on done', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0 })
  const started = store.get('r1')!.agents[0]!
  expect(typeof started.startedAt).toBe('number')
  expect(started.endedAt).toBeUndefined()

  bus.emit({ type: 'agent_done', runId: 'r1', agentId: 0, result: ok('x') })
  const done = store.get('r1')!.agents[0]!
  expect(typeof done.endedAt).toBe('number')
  expect(done.endedAt!).toBeGreaterThanOrEqual(done.startedAt!)
})

test('a restarted agent clears the previous run terminal state', () => {
  // The run-level journal resume builds a fresh context that hands out agent ids from 0
  // again, so the same id can legitimately start over; leaving the old ✗ and endedAt
  // behind would show a failed, already-finished row for an agent that is running again.
  // (In-place engine retries do NOT reach this branch — they emit agent_retry.)
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0 })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 0,
    result: { kind: 'dead', reason: 'api-error', detail: 'overloaded' },
  })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0 })

  const a = store.get('r1')!.agents[0]!
  expect(a.status).toBe('running')
  expect(a.resultKind).toBeUndefined()
  expect(a.endedAt).toBeUndefined()
  expect(a.failureReason).toBeUndefined()
  expect(a.failureDetail).toBeUndefined()
  expect(a.retryable).toBeUndefined()
})

// ---- agent_retry (in-place engine retry; must not restart the row) ----

test('agent_retry records the attempt without touching startedAt', async () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0, label: 'w1' })
  const startedAt = store.get('r1')!.agents[0]!.startedAt
  // let the clock move so a reset would be detectable
  await new Promise(r => {
    setTimeout(r, 5)
  })

  bus.emit({
    type: 'agent_retry',
    runId: 'r1',
    agentId: 0,
    label: 'w1',
    attempt: 1,
    limit: 3,
    reason: 'api-error',
    detail: 'overloaded',
    delayMs: 2_000,
  })

  const a = store.get('r1')!.agents[0]!
  // the elapsed clock spans the whole retry chain: startedAt must survive
  expect(a.startedAt).toBe(startedAt)
  expect(a.status).toBe('running')
  expect(a.endedAt).toBeUndefined()
  expect(a.retryCount).toBe(1)
  expect(a.retryLimit).toBe(3)
  expect(a.lastFailureReason).toBe('api-error')
  expect(a.lastFailureDetail).toBe('overloaded')
  expect(a.retryDelayMs).toBe(2_000)
  expect(typeof a.retryingSince).toBe('number')
  // an in-place retry never adds a second row
  expect(store.get('r1')!.agents).toHaveLength(1)
  expect(store.get('r1')!.agentCount).toBe(1)
})

test('successive agent_retry events overwrite the attempt counter, and success keeps the history', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0 })
  for (const attempt of [1, 2]) {
    bus.emit({
      type: 'agent_retry',
      runId: 'r1',
      agentId: 0,
      attempt,
      limit: 3,
      reason: 'api-error',
      delayMs: 100 * attempt,
    })
  }
  bus.emit({ type: 'agent_done', runId: 'r1', agentId: 0, result: ok('done') })

  const a = store.get('r1')!.agents[0]!
  expect(a.retryCount).toBe(2)
  expect(a.status).toBe('done')
  expect(a.resultKind).toBe('ok')
  // lastFailureReason describes an attempt the agent survived — it is NOT a terminal failure
  expect(a.lastFailureReason).toBe('api-error')
  expect(a.failureReason).toBeUndefined()
})

test('agent_retry for an unknown agentId is ignored (no phantom row)', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({
    type: 'agent_retry',
    runId: 'r1',
    agentId: 42,
    attempt: 1,
    limit: 3,
    reason: 'api-error',
    delayMs: 1,
  })
  expect(store.get('r1')!.agents).toHaveLength(0)
})

// ---- run_done sweeps abandoned agents (P3.7) ----

test('run_done killed forces still-running agents to a terminal state', () => {
  // A killed run tears the engine down mid-agent (possibly parked in a retry backoff),
  // so those agents never emit agent_done. Left alone they spin forever in the panel
  // with an elapsed timer that keeps climbing after the run itself went terminal.
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({
    type: 'agent_started',
    runId: 'r1',
    agentId: 0,
    label: 'finished',
  })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 1, label: 'running' })
  bus.emit({
    type: 'agent_retry',
    runId: 'r1',
    agentId: 1,
    attempt: 1,
    limit: 3,
    reason: 'api-error',
    delayMs: 4_000,
  })
  bus.emit({ type: 'agent_done', runId: 'r1', agentId: 0, result: ok('out') })
  bus.emit({ type: 'run_done', runId: 'r1', status: 'killed' })

  const [finished, abandoned] = store.get('r1')!.agents
  // the completed agent keeps its own result
  expect(finished!.status).toBe('done')
  expect(finished!.resultKind).toBe('ok')
  // the abandoned one is reaped as a failure, not left running
  expect(abandoned!.status).toBe('done')
  expect(abandoned!.resultKind).toBe('dead')
  expect(abandoned!.failureReason).toBe('run-killed')
  expect(typeof abandoned!.endedAt).toBe('number')
  // the "backing off" hint is cleared so nothing renders a pending retry
  expect(abandoned!.retryingSince).toBeUndefined()
  expect(abandoned!.retryDelayMs).toBeUndefined()
  // the retry history stays visible for post-mortem
  expect(abandoned!.retryCount).toBe(1)
})

test('run_done failed/completed also reap leftovers, tagged by how the run ended', () => {
  for (const [status, reason] of [
    ['failed', 'run-failed'],
    ['completed', 'run-ended'],
  ] as const) {
    const { bus, store } = newStore()
    bus.emit({
      type: 'run_started',
      runId: 'r1',
      workflowName: 'w',
      meta: null,
    })
    bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0 })
    bus.emit({ type: 'run_done', runId: 'r1', status })
    const a = store.get('r1')!.agents[0]!
    expect(a.status).toBe('done')
    expect(a.failureReason).toBe(reason)
  }
})

test('run_done does not rewrite agents that already reached a terminal state', () => {
  const { bus, store } = newStore()
  bus.emit({ type: 'run_started', runId: 'r1', workflowName: 'w', meta: null })
  bus.emit({ type: 'agent_started', runId: 'r1', agentId: 0 })
  bus.emit({
    type: 'agent_done',
    runId: 'r1',
    agentId: 0,
    result: { kind: 'dead', reason: 'prompt-too-long', retryable: false },
  })
  const endedAt = store.get('r1')!.agents[0]!.endedAt
  bus.emit({ type: 'run_done', runId: 'r1', status: 'killed' })

  const a = store.get('r1')!.agents[0]!
  expect(a.failureReason).toBe('prompt-too-long')
  expect(a.retryable).toBe(false)
  expect(a.endedAt).toBe(endedAt)
})
