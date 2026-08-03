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
let concurrentSessions: typeof import('../../../utils/session/concurrentSessions.js')
let bg: typeof import('../../bg.js')

beforeAll(async () => {
  concurrentSessions = await import(
    '../../../utils/session/concurrentSessions.js'
  )
  bg = await import('../../bg.js')
})

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'occ-session-registry-'))
  sessionsDir = join(tempDir, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
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
