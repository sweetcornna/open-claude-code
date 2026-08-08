import { expect, test } from 'bun:test'
// Note: this test does not mock bootstrap/state, utils/cwd, analytics, debug.
// Reason: mock.module is process-global (last-write-wins); mocking these common modules would pollute
// other tests in the same process (e.g. src/commands/__tests__/autonomy.test.ts imports the real
// bootstrap/state via its dependency chain). ports can resolve getProjectRoot/getCwd normally in the test env,
// logEvent/logForDebugging are silent no-ops when sink is not attached, no need to mock.

import { buildRegistry } from '../registry.js'
import { createWorkflowPorts } from '../ports.js'
import { createProgressBus } from '../progress/bus.js'
import { createProgressStoreFromBus } from '../progress/store.js'
import { getProjectRoot } from '../../bootstrap/state.js'
import type { SetAppState } from '../../Task.js'
import type { AppState } from '../../state/AppState.tsx'
import { registerLocalWorkflowTask } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

function createTaskHost(ports: ReturnType<typeof createWorkflowPorts>): {
  state: AppState
  setAppState: SetAppState
  host: ReturnType<typeof ports.hostFactory>
} {
  const state = { tasks: {} } as unknown as AppState
  const setAppState: SetAppState = f => {
    Object.assign(state, f(state))
  }
  const host = ports.hostFactory({
    context: { agentId: 'a-1', toolUseId: 'tu-1', setAppState },
    canUseTool: (() => Promise.resolve({ behavior: 'allow' })) as never,
    parentMessage: {} as never,
  })
  return { state, setAppState, host }
}

test('buildRegistry registers claude-code as default and resolve hits', () => {
  const reg = buildRegistry()
  expect(reg.has('claude-code')).toBe(true)
  expect(reg.resolve({ prompt: 'x' }).id).toBe('claude-code')
  expect(reg.resolve({ prompt: 'x', agentType: 'whatever' }).id).toBe(
    'claude-code',
  )
})

test('createWorkflowPorts assembles full ports (incl. agentAdapterRegistry and progressEmitter→bus)', () => {
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus)
  const ports = createWorkflowPorts({ bus, store })

  expect(ports.agentAdapterRegistry).toBeDefined()
  expect(ports.agentAdapterRegistry!.resolve({ prompt: 'x' }).id).toBe(
    'claude-code',
  )
  expect(typeof ports.taskRegistrar.register).toBe('function')
  expect(typeof ports.taskRegistrar.kill).toBe('function')
  expect(typeof ports.hostFactory).toBe('function')
  // agentRunner fallback fields still exist (WorkflowPorts required)
  expect(ports.agentRunner).toBeDefined()
  expect(typeof ports.agentRunner.runAgentToResult).toBe('function')

  // progressEmitter via bus → store: emit a run_started, store can see it
  ports.progressEmitter.emit({
    type: 'run_started',
    runId: 't',
    workflowName: 'w',
    meta: null,
  })
  expect(store.get('t')?.workflowName).toBe('w')
})

test('taskRegistrar.register/complete/kill routes via RunBinding (real setAppState, no mock)', () => {
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus)
  const ports = createWorkflowPorts({ bus, store })

  // real setAppState: use a local AppState object to hold tasks, registerTask goes through the real code path.
  const state = { tasks: {} } as unknown as AppState
  const setAppState: SetAppState = f => {
    Object.assign(state, f(state))
  }

  const hostCtx = ports.hostFactory({
    context: {
      agentId: 'a-1',
      toolUseId: 'tu-1',
      setAppState,
    },
    canUseTool: (() => Promise.resolve({ behavior: 'allow' })) as never,
    parentMessage: {} as never,
  })

  const { runId, signal } = ports.taskRegistrar.register(
    {
      workflowName: 'wf',
      summary: 'summary',
      workflowFile: 'wf.ts',
      toolUseId: 'tu-1',
    },
    hostCtx.handle,
  )
  expect(typeof runId).toBe('string')
  expect(signal).toBeInstanceOf(AbortSignal)

  // complete/fail/kill do not throw (RunBinding hit)
  expect(() => ports.taskRegistrar.complete(runId, 'done')).not.toThrow()
  expect(() => ports.taskRegistrar.kill(runId)).not.toThrow()
  // unknown runId safe no-op
  expect(() => ports.taskRegistrar.complete('nope')).not.toThrow()
  expect(ports.taskRegistrar.pendingAction('nope')).toBeNull()

  // after terminal state binding is reclaimed: calling complete on the same runId again should be safe no-op (no throw, no repeated call to workflow task fn)
  ports.taskRegistrar.complete(runId)
  ports.taskRegistrar.kill(runId)
})

// agent-level kill bridge: register → killAgent precisely aborts; kill(runId) aborts all agents.
test('taskRegistrar agentAbortControllers: register/killAgent precise abort; kill(runId) batch abort', () => {
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus)
  const ports = createWorkflowPorts({ bus, store })
  // impl always provides these — cast flattens optional to required (avoids per-line ! assertion)
  const tr = ports.taskRegistrar as Required<typeof ports.taskRegistrar>

  const state = { tasks: {} } as unknown as AppState
  const setAppState: SetAppState = f => {
    Object.assign(state, f(state))
  }
  const hostCtx = ports.hostFactory({
    context: { agentId: 'a-1', toolUseId: 'tu-1', setAppState },
    canUseTool: (() => Promise.resolve({ behavior: 'allow' })) as never,
    parentMessage: {} as never,
  })
  const { runId } = tr.register(
    {
      workflowName: 'wf',
      summary: 'summary',
      workflowFile: 'wf.ts',
      toolUseId: 'tu-1',
    },
    hostCtx.handle,
  )

  // register AbortController for two agents (simulating backend calling when launching agent)
  const ac1 = new AbortController()
  const ac2 = new AbortController()
  tr.registerAgentAbort(runId, 1, ac1)
  tr.registerAgentAbort(runId, 2, ac2)
  expect(ac1.signal.aborted).toBe(false)
  expect(ac2.signal.aborted).toBe(false)

  // killAgent precisely aborts agent #1: only ac1 aborts, ac2 unaffected
  expect(tr.killAgent(runId, 1)).toBe(true)
  expect(ac1.signal.aborted).toBe(true)
  expect(ac2.signal.aborted).toBe(false)
  // repeat kill on same agent: controller already deleted, returns false (idempotent)
  expect(tr.killAgent(runId, 1)).toBe(false)

  // unknown agentId / unknown runId safe returns false
  expect(tr.killAgent(runId, 999)).toBe(false)
  expect(tr.killAgent('nope', 1)).toBe(false)

  // kill(runId) batch aborts remaining agent (ac2)
  tr.kill(runId)
  expect(ac2.signal.aborted).toBe(true)

  // after run terminal state binding is reclaimed: killAgent returns false
  expect(tr.killAgent(runId, 2)).toBe(false)
})

test('unregisterAgentAbort deletes from Map (backend finally cleanup idempotent)', () => {
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus)
  const ports = createWorkflowPorts({ bus, store })
  const tr = ports.taskRegistrar as Required<typeof ports.taskRegistrar>

  const state = { tasks: {} } as unknown as AppState
  const setAppState: SetAppState = f => {
    Object.assign(state, f(state))
  }
  const hostCtx = ports.hostFactory({
    context: { agentId: 'a-1', toolUseId: 'tu-1', setAppState },
    canUseTool: (() => Promise.resolve({ behavior: 'allow' })) as never,
    parentMessage: {} as never,
  })
  const { runId } = tr.register(
    {
      workflowName: 'wf',
      summary: 'summary',
      workflowFile: 'wf.ts',
      toolUseId: 'tu-1',
    },
    hostCtx.handle,
  )
  const ac = new AbortController()
  tr.registerAgentAbort(runId, 5, ac)
  // after unregister killAgent has no target, returns false (does not throw)
  tr.unregisterAgentAbort(runId, 5)
  expect(tr.killAgent(runId, 5)).toBe(false)
  // repeat unregister idempotent (backend finally does not throw)
  expect(() => tr.unregisterAgentAbort(runId, 5)).not.toThrow()
  // unknown runId safe no-op
  expect(() => tr.unregisterAgentAbort('nope', 5)).not.toThrow()
})

test('hostFactory.cwd and journalStore share root (getProjectRoot) — fix K regression', () => {
  // historical bug: hostFactory.cwd used getCwd(), journalStore used getProjectRoot(),
  // when user enters worktree/subdirectory the two differ → named workflow resolution and journal persist out of sync.
  // After fix both use projectRoot, this test locks-in that choice, preventing regression.
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus)
  const ports = createWorkflowPorts({ bus, store })
  const hostCtx = ports.hostFactory({
    context: { agentId: 'a', toolUseId: 'tu' },
    canUseTool: (() => Promise.resolve({ behavior: 'allow' })) as never,
    parentMessage: {} as never,
  })
  expect(hostCtx.cwd).toBe(getProjectRoot())
})

test('duplicate active resume reuses one canonical binding and wrapper', () => {
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus)
  const ports = createWorkflowPorts({ bus, store })
  const { state, host } = createTaskHost(ports)

  const first = ports.taskRegistrar.register(
    { workflowName: 'wf', runId: 'w-resume' },
    host.handle,
  )
  const second = ports.taskRegistrar.register(
    { workflowName: 'wf', runId: 'w-resume' },
    host.handle,
  )

  expect(first.disposition).toBe('created')
  expect(second.disposition).toBe('existing')
  expect(second.instanceId).toBe(first.instanceId)
  expect(second.taskId).toBe(first.taskId)
  expect(second.signal).toBe(first.signal)
  expect(second.workflowName).toBe('wf')
  expect(second.runDir).toContain('w-resume')
  expect(
    Object.values(state.tasks).filter(
      task => task.type === 'local_workflow' && task.status === 'running',
    ),
  ).toHaveLength(1)
})

test('stale generation completion cannot remove or terminalize the newer binding', () => {
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus)
  const ports = createWorkflowPorts({ bus, store })
  const { state, host } = createTaskHost(ports)

  const first = ports.taskRegistrar.register(
    { workflowName: 'wf', runId: 'w-generation' },
    host.handle,
  )
  ports.taskRegistrar.complete(first.runId, 'first done', first.instanceId)
  const second = ports.taskRegistrar.register(
    { workflowName: 'wf', runId: first.runId },
    host.handle,
  )
  ports.taskRegistrar.complete(first.runId, 'stale done', first.instanceId)

  expect(second.instanceId).not.toBe(first.instanceId)
  expect(ports.getTaskIdForRun(first.runId)).toBe(second.taskId)
  expect(state.tasks[second.taskId!]?.status).toBe('running')
})

test('kill routes by runId or resumed wrapper taskId to the canonical controller', () => {
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus)
  const ports = createWorkflowPorts({ bus, store })
  const { host } = createTaskHost(ports)
  const registrar = ports.taskRegistrar as Required<typeof ports.taskRegistrar>

  const byTask = registrar.register(
    { workflowName: 'wf', runId: 'w-by-task' },
    host.handle,
  )
  const taskAgent = new AbortController()
  registrar.registerAgentAbort(byTask.runId, 1, taskAgent, byTask.instanceId)
  registrar.kill(byTask.taskId!)
  expect(byTask.signal.aborted).toBe(true)
  expect(taskAgent.signal.aborted).toBe(true)

  // Finish ownership transfer for the killed instance, then start another run.
  registrar.kill(byTask.runId, byTask.instanceId)
  const byRun = registrar.register(
    { workflowName: 'wf', runId: 'w-by-run' },
    host.handle,
  )
  registrar.kill(byRun.runId)
  expect(byRun.signal.aborted).toBe(true)
})

test('registration reconciles duplicate in-memory wrappers without leaving a running zombie', () => {
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus)
  const ports = createWorkflowPorts({ bus, store })
  const { state, setAppState, host } = createTaskHost(ports)
  const oldA = new AbortController()
  const oldB = new AbortController()
  const oldIds = [oldA, oldB].map(abortController =>
    registerLocalWorkflowTask(setAppState, {
      description: 'legacy duplicate',
      workflowName: 'wf',
      workflowFile: 'wf.ts',
      runId: 'w-legacy',
      abortController,
    }),
  )

  const canonical = ports.taskRegistrar.register(
    { workflowName: 'wf', runId: 'w-legacy' },
    host.handle,
  )

  expect(oldA.signal.aborted).toBe(true)
  expect(oldB.signal.aborted).toBe(true)
  for (const oldId of oldIds) {
    expect(state.tasks[oldId]?.status).toBe('killed')
    expect(
      (state.tasks[oldId] as { evictAfter?: number })?.evictAfter,
    ).toBeGreaterThan(Date.now())
  }
  const running = Object.values(state.tasks).filter(
    task =>
      task.type === 'local_workflow' &&
      task.runId === 'w-legacy' &&
      task.status === 'running',
  )
  expect(running.map(task => task.id)).toEqual([canonical.taskId!])
})

test('terminal progress persists before the live binding can be released', async () => {
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus)
  let releasePersistence: (() => void) | undefined
  const persistenceGate = new Promise<void>(resolve => {
    releasePersistence = resolve
  })
  let persistedStatus: string | undefined
  let persistedIdentity: { taskId?: string; instanceId?: number } | undefined
  const ports = createWorkflowPorts({
    bus,
    store,
    runsDir: '/tmp/workflow-runs-test',
    persistRunState: async run => {
      persistedStatus = run.status
      persistedIdentity = { taskId: run.taskId, instanceId: run.instanceId }
      await persistenceGate
    },
  })
  const { state, host } = createTaskHost(ports)
  const registration = ports.taskRegistrar.register(
    { workflowName: 'wf', runId: 'persist-first' },
    host.handle,
  )
  bus.emit({
    type: 'run_started',
    runId: registration.runId,
    taskId: registration.taskId,
    instanceId: registration.instanceId,
    workflowName: 'wf',
    meta: null,
  })
  bus.emit({
    type: 'run_done',
    runId: registration.runId,
    taskId: registration.taskId,
    instanceId: registration.instanceId,
    workflowName: 'wf',
    status: 'completed',
    returnValue: 'done',
  })

  const terminal = ports.taskRegistrar.complete(
    registration.runId,
    'done',
    registration.instanceId,
  )
  expect(persistedStatus).toBe('completed')
  expect(persistedIdentity).toEqual({
    taskId: registration.taskId,
    instanceId: registration.instanceId,
  })
  expect(ports.getTaskIdForRun(registration.runId)).toBe(registration.taskId)
  expect(state.tasks[registration.taskId!]?.status).toBe('running')

  releasePersistence?.()
  await terminal
  expect(state.tasks[registration.taskId!]?.status).toBe('completed')
  expect(ports.getTaskIdForRun(registration.runId)).toBeUndefined()
})
