import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { setupEnvUtilsMock } from '../../../../tests/mocks/envUtils.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { stateMockWith } from '../../../../tests/mocks/state.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module(
  'src/bootstrap/state.ts',
  stateMockWith({
    getSessionId: () => 'session-abc',
  }),
)

// Imported after mocks. The teammate helpers are the REAL implementations —
// they are the thing under test (the tag must disappear in team contexts), so
// mocking them would test nothing.
const {
  createTask,
  filterTasksForAgent,
  getTaskAgentTag,
  getTaskListId,
  isAgentScopedTask,
  listTasks,
  stripAgentTag,
  TASK_AGENT_ID_METADATA_KEY,
} = await import('../tasks.js')
const { setDynamicTeamContext } = await import('../../agents/teammate.js')
const { runWithTeammateContext } = await import(
  '../../agents/teammateContext.js'
)

type TaskLike = {
  id: string
  metadata?: Record<string, unknown>
}

const savedTaskListId = process.env.CLAUDE_CODE_TASK_LIST_ID

afterEach(() => {
  setDynamicTeamContext(null)
  if (savedTaskListId === undefined) {
    delete process.env.CLAUDE_CODE_TASK_LIST_ID
  } else {
    process.env.CLAUDE_CODE_TASK_LIST_ID = savedTaskListId
  }
})

describe('getTaskAgentTag', () => {
  test('main thread tasks stay untagged', () => {
    expect(getTaskListId()).toBe('session-abc')
    expect(getTaskAgentTag(undefined)).toBeUndefined()
  })

  test('a subagent writing into the session list gets tagged', () => {
    // This is the leak: getTaskListId() has no agent dimension, so a sync
    // subagent's TaskCreate lands in the user's own list.
    expect(getTaskAgentTag('agent-9')).toBe('agent-9')
  })

  test('in-process teammates stay untagged — the team list is shared on purpose', () => {
    const tagged = runWithTeammateContext(
      {
        agentId: 'researcher@alpha',
        agentName: 'researcher',
        teamName: 'alpha',
        planModeRequired: false,
        parentSessionId: 'session-abc',
        isInProcess: true,
        abortController: new AbortController(),
      },
      () => getTaskAgentTag('some-subagent-id'),
    )
    expect(tagged).toBeUndefined()
  })

  test('process-based teammates stay untagged', () => {
    setDynamicTeamContext({
      agentId: 'worker@alpha',
      agentName: 'worker',
      teamName: 'alpha',
      planModeRequired: false,
    })
    expect(getTaskListId()).toBe('alpha')
    expect(getTaskAgentTag('some-subagent-id')).toBeUndefined()
  })

  test('an explicit CLAUDE_CODE_TASK_LIST_ID list stays untagged', () => {
    process.env.CLAUDE_CODE_TASK_LIST_ID = 'tasklist'
    expect(getTaskAgentTag('agent-9')).toBeUndefined()
  })
})

describe('filterTasksForAgent', () => {
  const tasks: TaskLike[] = [
    { id: '1' },
    { id: '2', metadata: { [TASK_AGENT_ID_METADATA_KEY]: 'agent-9' } },
    { id: '3', metadata: { [TASK_AGENT_ID_METADATA_KEY]: 'agent-other' } },
    { id: '4', metadata: { note: 'no agent tag here' } },
  ]

  test('the main thread never sees subagent tasks', () => {
    expect(filterTasksForAgent(tasks, undefined).map(t => t.id)).toEqual([
      '1',
      '4',
    ])
  })

  test('a subagent sees the shared list plus its own tasks', () => {
    expect(filterTasksForAgent(tasks, 'agent-9').map(t => t.id)).toEqual([
      '1',
      '2',
      '4',
    ])
  })

  test('a non-string tag is ignored rather than hiding the task', () => {
    const weird: TaskLike[] = [
      { id: '1', metadata: { [TASK_AGENT_ID_METADATA_KEY]: 42 } },
    ]
    expect(filterTasksForAgent(weird, undefined).map(t => t.id)).toEqual(['1'])
  })
})

describe('the tag key is host-owned', () => {
  test('the key is underscore-prefixed like _internal', () => {
    // TaskCreate/TaskUpdate metadata is a model-controlled z.record. An
    // unprefixed 'agentId' collides with an obvious thing for a model to write
    // and would let it hide a main-thread task from the user permanently.
    expect(TASK_AGENT_ID_METADATA_KEY).toBe('_agentId')
  })

  test('stripAgentTag drops a forged tag and leaves everything else', () => {
    expect(
      stripAgentTag({ [TASK_AGENT_ID_METADATA_KEY]: 'agent-9', keep: 1 }),
    ).toEqual({ keep: 1 })
  })

  test('stripAgentTag passes untouched bags through by identity', () => {
    const clean = { keep: 1 }
    expect(stripAgentTag(clean)).toBe(clean)
    expect(stripAgentTag(undefined)).toBeUndefined()
  })

  test('a model-forged tag cannot hide a main-thread task', () => {
    // What TaskCreate does on the main thread: agentTag is undefined, so the
    // stripped bag is stored as-is and the task stays visible.
    const forged = { [TASK_AGENT_ID_METADATA_KEY]: 'agent-9', note: 'x' }
    const agentTag = getTaskAgentTag(undefined)
    const stored = agentTag
      ? { ...stripAgentTag(forged), [TASK_AGENT_ID_METADATA_KEY]: agentTag }
      : stripAgentTag(forged)

    const task = { id: '1', metadata: stored }
    expect(isAgentScopedTask(task)).toBe(false)
    expect(filterTasksForAgent([task], undefined).map(t => t.id)).toEqual(['1'])
  })
})

describe('tag round-trip through disk', () => {
  const envUtilsMock = setupEnvUtilsMock()
  let configHome: string

  beforeAll(async () => {
    configHome = await mkdtemp(join(tmpdir(), 'occ-agent-tasks-'))
    envUtilsMock.set({ getClaudeConfigHomeDir: () => configHome })
  })

  afterAll(async () => {
    envUtilsMock.reset()
    await rm(configHome, { recursive: true, force: true })
  })

  // TaskSchema must actually persist and re-parse the tag; if metadata were
  // dropped on read, filtering would silently degrade to "show everything".
  test('a subagent task written to disk is hidden from the main list but visible to its owner', async () => {
    const taskListId = 'roundtrip-list'
    await createTask(taskListId, {
      subject: 'user task',
      description: '',
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
    })
    await createTask(taskListId, {
      subject: 'subagent task',
      description: '',
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
      metadata: { [TASK_AGENT_ID_METADATA_KEY]: 'agent-9' },
    })

    const all = await listTasks(taskListId)
    expect(all).toHaveLength(2)

    expect(filterTasksForAgent(all, undefined).map(t => t.subject)).toEqual([
      'user task',
    ])
    expect(
      filterTasksForAgent(all, 'agent-9')
        .map(t => t.subject)
        .sort(),
    ).toEqual(['subagent task', 'user task'])
  })
})
