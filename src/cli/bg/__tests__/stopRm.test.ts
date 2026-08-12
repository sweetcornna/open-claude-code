/**
 * `stop` and `rm` against a real registry in a real temp config dir.
 *
 * `process.kill` is stubbed (the same technique sessionRegistry.test.ts uses)
 * because the alternative is signalling a process this test does not own; the
 * filesystem, the job store and the handlers themselves are all real.
 */

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
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
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

const JOB_ID = 'a1b2c3d4'
const SESSION_NAME = `${BIN_NAME}-bg-${JOB_ID}`

let tempDir: string
let sessionsDir: string
let logsDir: string
let jobsDir: string
let bg: typeof import('../../bg.js')
let jobStore: typeof import('../jobStore.js')
let concurrentSessions: typeof import('../../../utils/session/concurrentSessions.js')

beforeAll(async () => {
  bg = await import('../../bg.js')
  jobStore = await import('../jobStore.js')
  concurrentSessions = await import(
    '../../../utils/session/concurrentSessions.js'
  )
})

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'occ-stop-rm-'))
  sessionsDir = join(tempDir, 'sessions')
  logsDir = join(sessionsDir, 'logs')
  jobsDir = join(sessionsDir, 'jobs')
  process.env.OCC_CONFIG_DIR = tempDir
  await mkdir(logsDir, { recursive: true })
  await mkdir(jobsDir, { recursive: true })
  envUtilsMock.set({ getClaudeConfigHomeDir: () => tempDir })
})

afterEach(async () => {
  process.kill = originalKill
  // Must be 0, not undefined: Bun keeps the previously assigned value when
  // exitCode is set back to undefined, so a handler's `1` would leak out and
  // fail the whole run. Same reason as sessionRegistry.test.ts.
  process.exitCode = 0
  await rm(tempDir, { recursive: true, force: true })
})

afterAll(() => {
  envUtilsMock.reset()
  if (originalOccConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = originalOccConfigDir
  process.exitCode = 0
})

/** Register a live session owned by this process, so markers verify. */
async function registerLiveSession(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const processStartMarker = await concurrentSessions.getProcessStartMarker(
    process.pid,
  )
  const pidFile = join(sessionsDir, `${process.pid}.json`)
  await writeFile(
    pidFile,
    JSON.stringify({
      pid: process.pid,
      sessionId: 'test-session',
      cwd: tempDir,
      startedAt: Date.now(),
      kind: 'bg',
      name: SESSION_NAME,
      processStartMarker,
      ...overrides,
    }),
  )
  return pidFile
}

/**
 * Stub that reports the process as alive for probes and reacts to real
 * signals with the supplied behaviour.
 */
function stubKill(
  onSignal: (signal: NodeJS.Signals) => void,
  aliveAfterSignal = true,
): NodeJS.Signals[] {
  const signals: NodeJS.Signals[] = []
  let signalled = false
  process.kill = ((pid: number, signal?: NodeJS.Signals | 0) => {
    if (signal === 0 || signal === undefined) {
      if (signalled && !aliveAfterSignal) throw new Error('process gone')
      return true
    }
    signals.push(signal)
    signalled = true
    onSignal(signal)
    return true
  }) as typeof process.kill
  return signals
}

describe('stopHandler', () => {
  test('records a terminal job when the session is already gone', async () => {
    await registerLiveSession()
    const signals = stubKill(() => {
      throw new Error('session exited before SIGTERM')
    })

    await bg.stopHandler('test-session')

    expect(signals).toEqual(['SIGTERM'])
    const job = await jobStore.readJob(JOB_ID)
    expect(job?.state).toBe('stopped')
    expect(job?.detail).toBe('stopped')
    expect(job?.tempo).toBe('idle')
    expect(job?.firstTerminalAt).toBeGreaterThan(0)
  })

  test('never escalates to SIGKILL and leaves the job running', async () => {
    await registerLiveSession()
    const signals = stubKill(() => {}, true)

    await bg.stopHandler('test-session')

    expect(signals).toEqual(['SIGTERM'])
    // Still running after the grace period: stop reports it rather than
    // force-killing, and must not claim a terminal state it did not reach.
    expect(await jobStore.readJob(JOB_ID)).toBeUndefined()
  }, 10_000)

  test('refuses a registry entry that predates identity checks', async () => {
    await registerLiveSession({ processStartMarker: undefined })
    const signals = stubKill(() => {})

    await bg.stopHandler('test-session')

    expect(signals).toEqual([])
    expect(process.exitCode).toBe(1)
    expect(await jobStore.readJob(JOB_ID)).toBeUndefined()
  })

  test('reports an unknown target without touching anything', async () => {
    await bg.stopHandler('no-such-session')
    expect(process.exitCode).toBe(1)
    expect(await jobStore.listJobIds()).toEqual([])
  })
})

describe('killHandler', () => {
  test('writes a terminal job record after killing', async () => {
    await registerLiveSession()
    stubKill(() => {
      throw new Error('session exited before SIGTERM')
    })

    await bg.killHandler('test-session')

    const job = await jobStore.readJob(JOB_ID)
    expect(job?.state).toBe('stopped')
    expect(job?.detail).toBe('killed')
  })
})

describe('rmHandler', () => {
  test('removes the record and the managed log of a stopped job', async () => {
    const logPath = join(logsDir, `${SESSION_NAME}.log`)
    await writeFile(logPath, 'output')
    await jobStore.writeJob({
      jobId: JOB_ID,
      state: 'stopped',
      name: SESSION_NAME,
      sessionId: 'test-session',
      logPath,
    })

    await bg.rmHandler(SESSION_NAME)

    expect(process.exitCode).toBe(0)
    expect(await jobStore.readJob(JOB_ID)).toBeUndefined()
    expect(await Bun.file(logPath).exists()).toBe(false)
  })

  test('refuses a corrupt record instead of deleting it (records_unreadable)', async () => {
    const path = join(jobsDir, `${JOB_ID}.json`)
    await writeFile(path, '{ truncated')

    await bg.rmHandler(JOB_ID)

    expect(process.exitCode).toBe(1)
    expect(await Bun.file(path).exists()).toBe(true)
  })

  test('refuses while the job lock is held (live_lock)', async () => {
    await jobStore.writeJob({ jobId: JOB_ID, state: 'stopped' })
    // Held by this PID: a lock whose holder is alive is contended, and this
    // process is the only PID the test can prove is running. The "held by a
    // dead process" and "expired" reclaim paths are covered in
    // jobStore.test.ts against the same lock file.
    await writeFile(
      join(jobsDir, `${JOB_ID}.lock`),
      JSON.stringify({ pid: process.pid, at: Date.now() }),
    )

    await bg.rmHandler(JOB_ID)

    expect(process.exitCode).toBe(1)
    expect(await jobStore.readJob(JOB_ID)).toBeDefined()
  })

  test('refuses when the recorded PID is alive but unverifiable (unverified)', async () => {
    await jobStore.writeJob({
      jobId: JOB_ID,
      state: 'running',
      name: SESSION_NAME,
      pid: process.pid,
    })
    stubKill(() => {})

    await bg.rmHandler(JOB_ID)

    expect(process.exitCode).toBe(1)
    expect(await jobStore.readJob(JOB_ID)).toBeDefined()
  })

  test('refuses when the recorded PID was reused (identity_changed)', async () => {
    await jobStore.writeJob({
      jobId: JOB_ID,
      state: 'running',
      name: SESSION_NAME,
      pid: process.pid,
      processStartMarker: 'proc:not-the-current-marker',
    })
    stubKill(() => {})

    await bg.rmHandler(JOB_ID)

    expect(process.exitCode).toBe(1)
    expect(await jobStore.readJob(JOB_ID)).toBeDefined()
  })

  test('refuses when another live session claims the conversation (in_use)', async () => {
    await registerLiveSession({ name: 'someone-else', sessionId: 'shared' })
    await jobStore.writeJob({
      jobId: JOB_ID,
      state: 'stopped',
      name: SESSION_NAME,
      sessionId: 'shared',
      // Above every default pid_max, so the job's own process is definitively
      // gone while a different live session still has the conversation open.
      pid: 4194304,
    })

    await bg.rmHandler(JOB_ID)

    expect(process.exitCode).toBe(1)
    expect(await jobStore.readJob(JOB_ID)).toBeDefined()
  })

  test('refuses when another job shares the same log (shared_record)', async () => {
    const logPath = join(logsDir, `${SESSION_NAME}.log`)
    await writeFile(logPath, 'output')
    await jobStore.writeJob({
      jobId: JOB_ID,
      state: 'stopped',
      name: SESSION_NAME,
      logPath,
    })
    await jobStore.writeJob({
      jobId: 'ffffffff',
      state: 'stopped',
      name: `${BIN_NAME}-bg-ffffffff`,
      logPath,
    })

    await bg.rmHandler(JOB_ID)

    expect(process.exitCode).toBe(1)
    expect(await jobStore.readJob(JOB_ID)).toBeDefined()
    expect(await Bun.file(logPath).exists()).toBe(true)
  })

  test('stops a live session first, then removes it (occupied resolved)', async () => {
    await registerLiveSession()
    await jobStore.writeJob({
      jobId: JOB_ID,
      state: 'running',
      name: SESSION_NAME,
      sessionId: 'test-session',
    })
    const signals = stubKill(() => {
      throw new Error('session exited before SIGTERM')
    })

    await bg.rmHandler(SESSION_NAME)

    expect(signals).toEqual(['SIGTERM'])
    expect(process.exitCode).toBe(0)
    expect(await jobStore.readJob(JOB_ID)).toBeUndefined()
  })

  test('reports an unknown target rather than guessing', async () => {
    await bg.rmHandler('no-such-job')
    expect(process.exitCode).toBe(1)
  })
})
