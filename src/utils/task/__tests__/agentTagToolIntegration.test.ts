/**
 * Integration cover for the `_agentId` tag: drives the real
 * TaskCreateTool.call / TaskUpdateTool.call against a real task directory.
 *
 * The pure-helper tests in agentScopedTasks.test.ts pin getTaskAgentTag /
 * stripAgentTag / filterTasksForAgent, but they would all still pass if someone
 * deleted the stripAgentTag() call from either tool. These tests go through the
 * tools, so the model-forgery guard cannot be removed silently.
 */

import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { setupEnvUtilsMock } from '../../../../tests/mocks/envUtils.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'
import { stateMockWith } from '../../../../tests/mocks/state.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module(
  'src/bootstrap/state.js',
  stateMockWith({
    getSessionId: () => 'session-tag-integration',
    getIsNonInteractiveSession: () => false,
  }),
)

// Complete-surface wrap of the hooks barrel: only the TaskCreated generator is
// stubbed (it would otherwise read hook settings and spawn processes). A
// hand-written partial mock here would erase the other 7 exports for every file
// loaded later in the process.
const realHooks = await import('src/utils/hooks.js')
const hooksMock = makeSharedModuleMock('src/utils/hooks.js', realHooks).setup()

const envUtilsMock = setupEnvUtilsMock()

const { TaskCreateTool } = await import(
  '@open-claude-code/builtin-tools/tools/TaskCreateTool/TaskCreateTool.js'
)
const { TaskUpdateTool } = await import(
  '@open-claude-code/builtin-tools/tools/TaskUpdateTool/TaskUpdateTool.js'
)
const {
  getTaskListId,
  listTasks,
  filterTasksForAgent,
  TASK_AGENT_ID_METADATA_KEY,
} = await import('../tasks.js')

let configHome: string

beforeAll(async () => {
  configHome = await mkdtemp(join(tmpdir(), 'occ-tag-integration-'))
  envUtilsMock.set({ getClaudeConfigHomeDir: () => configHome })
  hooksMock.set({
    executeTaskCreatedHooks: async function* () {
      // no hooks configured — yields nothing
    },
  } as never)
})

afterAll(async () => {
  envUtilsMock.reset()
  hooksMock.reset()
  await rm(configHome, { recursive: true, force: true })
})

afterEach(async () => {
  // Each test asserts on the whole list, so start from a clean directory.
  const dir = join(configHome, 'tasks')
  await rm(dir, { recursive: true, force: true })
})

function ctx(agentId?: string): never {
  return {
    agentId,
    setAppState: () => {},
    abortController: new AbortController(),
  } as never
}

async function create(
  input: { subject: string; metadata?: Record<string, unknown> },
  agentId?: string,
): Promise<string> {
  const result = await TaskCreateTool.call(
    { subject: input.subject, description: 'd', metadata: input.metadata },
    ctx(agentId),
  )
  return (result as { data: { task: { id: string } } }).data.task.id
}

async function tagOf(taskId: string): Promise<unknown> {
  const tasks = await listTasks(getTaskListId())
  return tasks.find(t => t.id === taskId)?.metadata?.[
    TASK_AGENT_ID_METADATA_KEY
  ]
}

test('TaskCreate tags a subagent task, and the main list hides it', async () => {
  const userTaskId = await create({ subject: 'user task' })
  const subagentTaskId = await create({ subject: 'subagent task' }, 'agent-9')

  expect(await tagOf(userTaskId)).toBeUndefined()
  expect(await tagOf(subagentTaskId)).toBe('agent-9')

  const visibleToMain = filterTasksForAgent(
    await listTasks(getTaskListId()),
    undefined,
  )
  expect(visibleToMain.map(t => t.subject)).toEqual(['user task'])
})

test('TaskCreate strips a model-forged tag on the main thread', async () => {
  // Without stripAgentTag in TaskCreateTool this stores '_agentId: forged' and
  // the task vanishes from the user's todo UI forever.
  const taskId = await create({
    subject: 'user task',
    metadata: { [TASK_AGENT_ID_METADATA_KEY]: 'forged', keep: 'me' },
  })

  expect(await tagOf(taskId)).toBeUndefined()

  const tasks = await listTasks(getTaskListId())
  expect(tasks[0]!.metadata?.keep).toBe('me')
  expect(filterTasksForAgent(tasks, undefined)).toHaveLength(1)
})

test('TaskUpdate cannot forge a tag onto an untagged task', async () => {
  const taskId = await create({ subject: 'user task' })

  await TaskUpdateTool.call(
    {
      taskId,
      metadata: { [TASK_AGENT_ID_METADATA_KEY]: 'forged', note: 'ok' },
    },
    ctx(),
  )

  expect(await tagOf(taskId)).toBeUndefined()
  const tasks = await listTasks(getTaskListId())
  // The rest of the metadata bag still merges normally.
  expect(tasks[0]!.metadata?.note).toBe('ok')
  expect(filterTasksForAgent(tasks, undefined)).toHaveLength(1)
})

test('TaskUpdate cannot delete an existing tag to un-hide a subagent task', async () => {
  const taskId = await create({ subject: 'subagent task' }, 'agent-9')

  // null means "delete this key" in TaskUpdate's metadata merge — but the tag
  // is host-owned, so the key must survive.
  await TaskUpdateTool.call(
    { taskId, metadata: { [TASK_AGENT_ID_METADATA_KEY]: null } },
    ctx('agent-9'),
  )

  expect(await tagOf(taskId)).toBe('agent-9')
  expect(
    filterTasksForAgent(await listTasks(getTaskListId()), undefined),
  ).toHaveLength(0)
})
