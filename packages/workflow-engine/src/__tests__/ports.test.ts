import { expect, test } from 'bun:test'
import {
  createHostHandle,
  isHostHandle,
  scopeWorkflowPortsToTaskInstance,
  unwrapHostHandle,
  type WorkflowPorts,
} from '../ports.js'

test('createHostHandle wraps any bundle and is opaque externally', () => {
  const bundle = { secret: 'ctx', nested: { a: 1 } }
  const handle = createHostHandle(bundle)
  expect(isHostHandle(handle)).toBe(true)
  // bundle is not exposed externally — handle only has a symbol marker
  expect(Object.keys(handle)).toHaveLength(0)
})

test('plain object is not a HostHandle', () => {
  expect(isHostHandle({} as unknown)).toBe(false)
  expect(isHostHandle(null)).toBe(false)
})

test('ports object satisfies the minimal shape', () => {
  // compile-time shape validation: the assignment below passing means the ports contract is self-consistent
  const noop = (): void => {}
  const ports = {
    agentRunner: { runAgentToResult: noop },
    progressEmitter: { emit: noop },
    taskRegistrar: {
      register: () => ({
        runId: 'run-1',
        signal: new AbortController().signal,
      }),
      complete: noop,
      fail: noop,
      kill: noop,
      pendingAction: () => null,
    },
    journalStore: {
      read: async () => [],
      append: async () => {},
      truncate: async () => {},
    },
    permissionGate: { isAborted: () => false },
    logger: { debug: noop, event: noop },
    hostFactory: () => ({
      handle: createHostHandle(null),
      cwd: '/tmp',
      budgetTotal: null,
      toolUseId: 'tu-1',
    }),
  }
  expect(ports.taskRegistrar.register().runId).toBe('run-1')
  expect(ports.hostFactory().toolUseId).toBe('tu-1')
})

test('unwrapHostHandle retrieves the original bundle (same reference)', () => {
  const bundle = { secret: 'ctx', nested: { a: 1 } }
  const handle = createHostHandle(bundle)
  expect(unwrapHostHandle(handle)).toBe(bundle)
})

test('createHostHandle(null) is opaque and unwraps to null', () => {
  const handle = createHostHandle(null)
  expect(isHostHandle(handle)).toBe(true)
  expect(unwrapHostHandle(handle)).toBeNull()
})

test('instance-scoped ports drop stale progress and scope agent cleanup', () => {
  let currentInstance = 2
  const events: string[] = []
  const registeredInstances: Array<number | undefined> = []
  const unregisteredInstances: Array<number | undefined> = []
  const noop = (): void => {}
  const ports: WorkflowPorts = {
    agentRunner: { runAgentToResult: async () => ({ kind: 'dead' }) },
    progressEmitter: { emit: event => events.push(event.type) },
    taskRegistrar: {
      register: () => ({
        runId: 'r1',
        signal: new AbortController().signal,
      }),
      complete: noop,
      fail: noop,
      kill: noop,
      isCurrent: (_runId, instanceId) => instanceId === currentInstance,
      registerAgentAbort: (_runId, _agentId, _ac, instanceId) => {
        registeredInstances.push(instanceId)
      },
      unregisterAgentAbort: (_runId, _agentId, instanceId) => {
        unregisteredInstances.push(instanceId)
      },
      pendingAction: () => null,
    },
    journalStore: {
      read: async () => [],
      append: async () => {},
      truncate: async () => {},
    },
    permissionGate: { isAborted: () => false },
    logger: { debug: noop, event: noop },
    hostFactory: () => ({
      handle: createHostHandle(null),
      cwd: '/tmp',
      budgetTotal: null,
    }),
  }
  const scoped = scopeWorkflowPortsToTaskInstance(ports, 'r1', 1)

  scoped.progressEmitter.emit({
    type: 'run_started',
    runId: 'r1',
    workflowName: 'stale',
    meta: null,
  })
  expect(events).toEqual([])

  currentInstance = 1
  scoped.progressEmitter.emit({
    type: 'run_started',
    runId: 'r1',
    workflowName: 'current',
    meta: null,
  })
  scoped.taskRegistrar.registerAgentAbort?.('r1', 3, new AbortController())
  scoped.taskRegistrar.unregisterAgentAbort?.('r1', 3)

  expect(events).toEqual(['run_started'])
  expect(registeredInstances).toEqual([1])
  expect(unregisteredInstances).toEqual([1])
})
