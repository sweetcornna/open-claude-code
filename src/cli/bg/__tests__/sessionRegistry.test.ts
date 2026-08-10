import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { BIN_NAME } from '../../../constants/brand.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { setupEnvUtilsMock } from '../../../../tests/mocks/envUtils.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('bun:bundle', () => ({
  feature: (name: string) => name === 'BG_SESSIONS',
}))
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const envUtilsMock = setupEnvUtilsMock()
const originalKill = process.kill
const originalOccConfigDir = process.env.OCC_CONFIG_DIR
const envKeys = [
  'CLAUDE_CODE_SESSION_KIND',
  'CLAUDE_CODE_SESSION_NAME',
  'CLAUDE_CODE_SESSION_LOG',
  'CLAUDE_CODE_SESSION_ENGINE',
  'CLAUDE_CODE_TMUX_SESSION',
] as const
const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

let tempDir: string
let sessionsDir: string
let logsDir: string
let concurrentSessions: typeof import('../../../utils/session/concurrentSessions.js')
let cleanupRegistry: typeof import('../../../utils/process/cleanupRegistry.js')
let bg: typeof import('../../bg.js')

beforeAll(async () => {
  concurrentSessions = await import(
    '../../../utils/session/concurrentSessions.js'
  )
  cleanupRegistry = await import('../../../utils/process/cleanupRegistry.js')
  bg = await import('../../bg.js')
})

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'occ-session-registry-'))
  sessionsDir = join(tempDir, 'sessions')
  logsDir = join(sessionsDir, 'logs')
  process.env.OCC_CONFIG_DIR = tempDir
  await mkdir(logsDir, { recursive: true })
  envUtilsMock.set({ getClaudeConfigHomeDir: () => tempDir })
})

afterEach(async () => {
  process.kill = originalKill
  // Must be 0, not undefined: unlike Node, Bun keeps the previously assigned
  // value when exitCode is set back to undefined, so killHandler's `1` would
  // leak out and fail the whole `bun test` run even with zero test failures.
  process.exitCode = 0
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(tempDir, { recursive: true, force: true })
})

afterAll(() => {
  envUtilsMock.reset()
  if (originalOccConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = originalOccConfigDir
  process.exitCode = 0
})

function registryEntry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: process.pid,
    sessionId: 'test-session',
    cwd: tempDir,
    startedAt: Date.now(),
    kind: 'bg',
    ...overrides,
  })
}

function managedLogPath(id = '1234abcd'): string {
  return join(logsDir, `${BIN_NAME}-bg-${id}.log`)
}

describe('background session registry', () => {
  test('builds tmux registry metadata used by attach', async () => {
    process.env.CLAUDE_CODE_SESSION_KIND = 'bg'
    process.env.CLAUDE_CODE_SESSION_NAME = 'registered-bg'
    process.env.CLAUDE_CODE_SESSION_LOG = join(tempDir, 'registered.log')
    process.env.CLAUDE_CODE_SESSION_ENGINE = 'tmux'
    process.env.CLAUDE_CODE_TMUX_SESSION = 'registered-tmux'

    expect(concurrentSessions.getBgSessionMetadata()).toEqual({
      name: 'registered-bg',
      logPath: join(tempDir, 'registered.log'),
      agent: undefined,
      engine: 'tmux',
      tmuxSessionName: 'registered-tmux',
    })

    expect(await concurrentSessions.registerSession()).toBe(true)
    const entry = JSON.parse(
      await readFile(join(sessionsDir, `${process.pid}.json`), 'utf8'),
    ) as Record<string, unknown>
    expect(entry.processStartMarker).toBe(
      await concurrentSessions.getProcessStartMarker(process.pid),
    )
  })

  test('removes its managed log during normal session cleanup', async () => {
    const logPath = managedLogPath()
    process.env.CLAUDE_CODE_SESSION_KIND = 'bg'
    process.env.CLAUDE_CODE_SESSION_NAME = 'registered-bg'
    process.env.CLAUDE_CODE_SESSION_LOG = logPath
    await writeFile(logPath, 'session output')

    expect(await concurrentSessions.registerSession()).toBe(true)
    const pidFile = join(sessionsDir, `${process.pid}.json`)
    expect(await Bun.file(pidFile).exists()).toBe(true)

    await cleanupRegistry.runCleanupFunctions()

    expect(await Bun.file(pidFile).exists()).toBe(false)
    expect(await Bun.file(logPath).exists()).toBe(false)
  })

  test('only removes launcher-managed direct-child log files', async () => {
    const managed = managedLogPath()
    const outside = join(tempDir, `${BIN_NAME}-bg-deadbeef.log`)
    const unmanaged = join(logsDir, 'notes.log')
    const nested = join(logsDir, 'nested', `${BIN_NAME}-bg-feedface.log`)
    await mkdir(join(logsDir, 'nested'), { recursive: true })
    await Promise.all([
      writeFile(managed, 'managed'),
      writeFile(outside, 'outside'),
      writeFile(unmanaged, 'unmanaged'),
      writeFile(nested, 'nested'),
    ])

    await Promise.all([
      concurrentSessions.removeManagedSessionLog(managed),
      concurrentSessions.removeManagedSessionLog(outside),
      concurrentSessions.removeManagedSessionLog(unmanaged),
      concurrentSessions.removeManagedSessionLog(nested),
    ])

    expect(await Bun.file(managed).exists()).toBe(false)
    expect(await Bun.file(outside).exists()).toBe(true)
    expect(await Bun.file(unmanaged).exists()).toBe(true)
    expect(await Bun.file(nested).exists()).toBe(true)
  })

  test('rejects a registry whose JSON PID differs from its filename', async () => {
    const pidFile = join(sessionsDir, `${process.pid}.json`)
    await writeFile(pidFile, registryEntry({ pid: process.pid + 1 }))

    expect(await bg.listLiveSessions()).toEqual([])
    expect(await Bun.file(pidFile).exists()).toBe(false)
  })

  test('rejects a stale registry when the PID start marker changed', async () => {
    const pidFile = join(sessionsDir, `${process.pid}.json`)
    await writeFile(
      pidFile,
      registryEntry({ processStartMarker: 'proc:stale-marker' }),
    )

    expect(await bg.listLiveSessions()).toEqual([])
    expect(await Bun.file(pidFile).exists()).toBe(false)
  })

  test('removes a managed log while pruning a stale registry', async () => {
    const stalePid = 1
    const pidFile = join(sessionsDir, `${stalePid}.json`)
    const logPath = managedLogPath()
    await writeFile(logPath, 'stale output')
    await writeFile(pidFile, registryEntry({ pid: stalePid, logPath }))

    expect(await bg.listLiveSessions()).toEqual([])

    expect(await Bun.file(pidFile).exists()).toBe(false)
    expect(await Bun.file(logPath).exists()).toBe(false)
  })

  test('removes a managed log when daemon kill finds an exited session', async () => {
    const pidFile = join(sessionsDir, `${process.pid}.json`)
    const logPath = managedLogPath()
    const processStartMarker = await concurrentSessions.getProcessStartMarker(
      process.pid,
    )
    await writeFile(logPath, 'session output')
    await writeFile(pidFile, registryEntry({ logPath, processStartMarker }))
    const signals: Array<NodeJS.Signals | 0 | undefined> = []
    process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
      expect(pid).toBe(process.pid)
      signals.push(signal)
      if (signal === 0 || signal === undefined) return true
      throw new Error('session exited before SIGTERM')
    }) as typeof process.kill

    await bg.killHandler('test-session')

    expect(signals).toEqual([0, 'SIGTERM'])
    expect(await Bun.file(pidFile).exists()).toBe(false)
    expect(await Bun.file(logPath).exists()).toBe(false)
  })

  test('refuses to signal legacy entries without a process identity', async () => {
    const pidFile = join(sessionsDir, `${process.pid}.json`)
    await writeFile(pidFile, registryEntry({ sessionId: 'legacy-session' }))
    const signals: Array<NodeJS.Signals | 0 | undefined> = []
    process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
      expect(pid).toBe(process.pid)
      signals.push(signal)
      if (signal === 0 || signal === undefined) return true
      throw new Error('test blocked signal')
    }) as typeof process.kill

    await bg.killHandler('legacy-session')

    expect(signals).toEqual([0])
    expect(process.exitCode).toBe(1)
    expect(await Bun.file(pidFile).exists()).toBe(true)
  })
})
