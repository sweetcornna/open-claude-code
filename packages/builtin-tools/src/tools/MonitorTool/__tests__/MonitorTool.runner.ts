/**
 * MonitorTool.runner.ts
 *
 * 真正的 MonitorTool 测试体，由 MonitorTool.test.ts 在独立子进程中运行。
 *
 * 之所以要隔离：本文件必须 mock `src/utils/Shell.js` 和
 * `src/tasks/LocalShellTask/LocalShellTask.js` 才能在不真正 spawn 进程的前提下
 * 断言 wait 模式走的是同一条 exec/spawnShellTask 通路。这两个模块被 14+ 个
 * 生产模块引用（QueryEngine、main.tsx、BashTool…），而 Bun 的 mock.module 是
 * 进程全局的，留在主测试进程里会污染同一次 `bun test` 的其他文件。
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

type ExecCall = { command: string; shellType: string }
type SpawnCall = {
  command: string
  description: string
  kind: string
  toolUseId?: string
  agentId?: string
}

const execCalls: ExecCall[] = []
const spawnCalls: SpawnCall[] = []

// Spread the real modules so only exec/spawnShellTask are stubbed — replacing
// the whole module would strip exports other importers still need.
const realShell = await import('src/utils/Shell.js')
mock.module('src/utils/Shell.js', () => ({
  ...realShell,
  exec: async (command: string, _signal: AbortSignal, shellType: string) => {
    execCalls.push({ command, shellType })
    return {
      taskOutput: { taskId: 'task-test-1' },
      background: () => {},
      result: new Promise(() => {}),
    }
  },
}))

const realLocalShellTask = await import(
  'src/tasks/LocalShellTask/LocalShellTask.js'
)
mock.module('src/tasks/LocalShellTask/LocalShellTask.js', () => ({
  ...realLocalShellTask,
  spawnShellTask: async (input: SpawnCall) => {
    spawnCalls.push(input)
    return { taskId: 'task-test-1' }
  },
}))

const { MonitorTool } = await import('../MonitorTool.js')
const { getTaskOutputPath } = await import('src/utils/task/diskOutput.js')

function makeCallContext() {
  return {
    abortController: new AbortController(),
    setAppState: () => {},
    getAppState: () => ({}),
    toolUseId: 'toolu_test',
    agentId: undefined,
  } as never
}

/** validateInput returns a union — narrow it once so tests can read errorCode. */
async function validate(input: Record<string, unknown>) {
  const result = await MonitorTool.validateInput!(input as never)
  return result as { result: boolean; message?: string; errorCode?: number }
}

describe('MonitorTool.validateInput', () => {
  test('rejects when both command and wait_seconds are provided', async () => {
    const result = await validate({
      command: 'tail -f app.log',
      wait_seconds: 30,
      description: 'both',
    })

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(3)
    expect(result.message).toContain('not both')
  })

  test('rejects when neither command nor wait_seconds is provided', async () => {
    const result = await validate({ description: 'neither' })

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(4)
  })

  test('accepts command mode on its own', async () => {
    const result = await validate({
      command: 'tail -f app.log',
      description: 'Watch app log',
    })

    expect(result.result).toBe(true)
  })

  test('accepts wait_seconds mode on its own, without a description', async () => {
    const result = await validate({ wait_seconds: 300 })

    expect(result.result).toBe(true)
  })

  test('still rejects an empty command in command mode', async () => {
    const result = await validate({
      command: '   ',
      description: 'Watch app log',
    })

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(1)
  })

  test('still rejects a missing description in command mode', async () => {
    const result = await validate({ command: 'tail -f app.log' })

    expect(result.result).toBe(false)
    expect(result.errorCode).toBe(2)
  })
})

describe('MonitorTool.checkPermissions', () => {
  test('allows wait mode without consulting bash permissions', async () => {
    const result = await MonitorTool.checkPermissions!(
      { wait_seconds: 30 },
      makeCallContext(),
    )

    expect(result.behavior).toBe('allow')
  })
})

describe('MonitorTool.call', () => {
  beforeEach(() => {
    execCalls.length = 0
    spawnCalls.length = 0
  })

  test('wait mode spawns a shell task running a background sleep', async () => {
    const result = await MonitorTool.call(
      { wait_seconds: 45 },
      makeCallContext(),
    )

    expect(execCalls).toHaveLength(1)
    expect(execCalls[0]!.command).toBe('sleep 45')
    expect(execCalls[0]!.shellType).toBe('bash')

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]!.command).toBe('sleep 45')
    // Same task kind as command mode — no separate notification plumbing.
    expect(spawnCalls[0]!.kind).toBe('monitor')
    expect(spawnCalls[0]!.description).toBe('Wake-up timer: 45s')

    expect(result.data).toEqual({
      taskId: 'task-test-1',
      outputFile: getTaskOutputPath('task-test-1'),
    })
  })

  test('wait mode keeps an explicit description', async () => {
    await MonitorTool.call(
      { wait_seconds: 10, description: 'Re-check the deploy' },
      makeCallContext(),
    )

    expect(spawnCalls[0]!.description).toBe('Re-check the deploy')
  })

  test('command mode still runs the command verbatim', async () => {
    await MonitorTool.call(
      { command: 'tail -f app.log', description: 'Watch app log' },
      makeCallContext(),
    )

    expect(execCalls[0]!.command).toBe('tail -f app.log')
    expect(spawnCalls[0]!.command).toBe('tail -f app.log')
    expect(spawnCalls[0]!.kind).toBe('monitor')
  })
})
