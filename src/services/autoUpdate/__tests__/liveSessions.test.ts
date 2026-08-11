/**
 * Tests for the live-session registry (liveSessions.ts).
 *
 * Everything runs against a temp OCC_CONFIG_DIR — `occConfigDir` is memoized
 * on the env var, so pointing it at a scratch directory is enough to keep the
 * user's real ~/.occ untouched.
 *
 * Only the log/debug leaves are mock.module'd (shared mocks, per CLAUDE.md).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let live: typeof import('../liveSessions.js')
let cleanupRegistry: typeof import('src/utils/process/cleanupRegistry.js')
let distRootValue: string
let configDir: string
const previousConfigDir = process.env.OCC_CONFIG_DIR

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'occ-live-sessions-'))
  process.env.OCC_CONFIG_DIR = configDir
  live = await import('../liveSessions.js')
  cleanupRegistry = await import('src/utils/process/cleanupRegistry.js')
  distRootValue = (await import('src/utils/filesystem/distRoot.js')).distRoot
})

afterAll(() => {
  if (previousConfigDir === undefined) {
    delete process.env.OCC_CONFIG_DIR
  } else {
    process.env.OCC_CONFIG_DIR = previousConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

function sessionsDir(): string {
  return join(configDir, 'live-sessions')
}

/** A lease in the legacy format: the bare dist root, no start time. */
async function writeEntry(pid: number, root = distRootValue): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true })
  await writeFile(join(sessionsDir(), String(pid)), root, 'utf8')
}

/** A lease in the current format, carrying start time and heartbeat. */
async function writeDatedEntry(
  pid: number,
  startedAt: number,
  options: { root?: string; renewedAt?: number } = {},
): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true })
  await writeFile(
    join(sessionsDir(), String(pid)),
    JSON.stringify({
      schemaVersion: 2,
      distRoot: options.root ?? distRootValue,
      startedAt,
      renewedAt: options.renewedAt ?? Date.now(),
    }),
    'utf8',
  )
}

afterEach(async () => {
  live.resetLiveSessionsForTests()
  rmSync(sessionsDir(), { recursive: true, force: true })
})

/** A pid that is guaranteed to be gone: a child we already reaped. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['--version'])
  return result.pid ?? 2 ** 22
}

/** Roots reported for live sessions, ignoring the completeness flag. */
async function liveRoots(): Promise<Set<string>> {
  return (await live.getLiveSessionDistRoots()).roots
}

describe('registerLiveSession', () => {
  test('does not resolve until this process lease is visible', async () => {
    await live.registerLiveSession()

    const entry = join(sessionsDir(), String(process.pid))
    expect(existsSync(entry)).toBe(true)
    expect(
      (JSON.parse(await readFile(entry, 'utf8')) as { distRoot: string })
        .distRoot,
    ).toBe(distRootValue)
  })

  test('removes its lease at exit', async () => {
    await live.registerLiveSession()

    await cleanupRegistry.runCleanupFunctions()

    expect(existsSync(join(sessionsDir(), String(process.pid)))).toBe(false)
  })

  test('records this process start time and a heartbeat in its own lease', async () => {
    await live.registerLiveSession()

    const raw = await readFile(join(sessionsDir(), String(process.pid)), 'utf8')
    const lease = JSON.parse(raw) as {
      distRoot: string
      startedAt: number
      renewedAt: number
    }

    expect(lease.distRoot).toBe(distRootValue)
    const expected = Date.now() - process.uptime() * 1000
    expect(Math.abs(lease.startedAt - expected)).toBeLessThan(2_000)
    expect(Math.abs(lease.renewedAt - Date.now())).toBeLessThan(2_000)
  })

  test('refreshes its own lease on the heartbeat interval', async () => {
    // Staleness on win32 has nothing but this write to go on: `ps` is not
    // available there, so a lease that stops being refreshed is the only
    // evidence that a pid was recycled onto an unrelated process.
    const entry = join(sessionsDir(), String(process.pid))
    await live.registerLiveSession({ heartbeatIntervalMs: 5 })
    const before = JSON.parse(await readFile(entry, 'utf8')) as {
      renewedAt: number
    }

    await Bun.sleep(60)

    const after = JSON.parse(await readFile(entry, 'utf8')) as {
      renewedAt: number
    }
    expect(after.renewedAt).toBeGreaterThan(before.renewedAt)
  })

  test('stops the heartbeat at exit', async () => {
    const entry = join(sessionsDir(), String(process.pid))
    await live.registerLiveSession({ heartbeatIntervalMs: 5 })

    await cleanupRegistry.runCleanupFunctions()
    await Bun.sleep(40)

    // A heartbeat that outlived cleanup would recreate the lease it just
    // removed, leaving a permanently live phantom session behind.
    expect(existsSync(entry)).toBe(false)
  })
})

describe('getLiveSessionDistRoots', () => {
  test('reports this process own root when the registry does not exist yet', async () => {
    const result = await live.getLiveSessionDistRoots()
    expect([...result.roots]).toEqual([distRootValue])
    expect(result.complete).toBe(true)
  })

  test('reports the root of another live process', async () => {
    // process.ppid is alive by construction and is not us.
    await writeEntry(process.ppid, '/somewhere/else/dist')
    expect([...(await liveRoots())].sort()).toEqual(
      [distRootValue, '/somewhere/else/dist'].sort(),
    )
  })

  test('prunes entries whose process is gone, so a crash cannot pin a farm', async () => {
    const gone = deadPid()
    await writeEntry(gone, '/gone/dist')

    expect(await liveRoots()).not.toContain('/gone/dist')
    expect(await readdir(sessionsDir())).not.toContain(String(gone))
  })

  test('a malformed filename is ignored rather than throwing', async () => {
    await mkdir(sessionsDir(), { recursive: true })
    await writeFile(join(sessionsDir(), 'not-a-pid'), distRootValue, 'utf8')
    const result = await live.getLiveSessionDistRoots()
    expect(result.complete).toBe(true)
  })

  test('an unreadable lease marks the answer incomplete', async () => {
    // A live pid whose tree we cannot name must not license deleting anything.
    await mkdir(sessionsDir(), { recursive: true })
    await mkdir(join(sessionsDir(), String(process.ppid)), { recursive: true })

    const result = await live.getLiveSessionDistRoots()
    expect(result.complete).toBe(false)
  })

  test('still honours a legacy lease that has no start time', async () => {
    // A session registered by the previous build is reading chunks out of its
    // tree; a fresh mtime is the only heartbeat it has.
    await writeEntry(process.ppid, '/legacy/dist')
    live.setProcessStartTimeProbeForTests(async () => new Map())
    expect(await liveRoots()).toContain('/legacy/dist')
  })

  test('reports a live process whose recorded start time matches', async () => {
    const startedAt = 1_000_000
    await writeDatedEntry(process.ppid, startedAt, { root: '/peer/dist' })
    live.setProcessStartTimeProbeForTests(async pids => {
      expect(pids).toContain(process.ppid)
      return new Map([[process.ppid, startedAt]])
    })

    expect(await liveRoots()).toContain('/peer/dist')
    expect(await readdir(sessionsDir())).toContain(String(process.ppid))
  })

  test('prunes a lease whose pid was recycled onto a newer process', async () => {
    // A `-p` session SIGKILLed before cleanup leaves its lease behind. Once
    // the OS hands that pid to something unrelated, the lease reads as
    // permanently live and pins a farm that nothing is running from.
    const startedAt = 1_000_000
    await writeDatedEntry(process.ppid, startedAt, { root: '/peer/dist' })
    live.setProcessStartTimeProbeForTests(
      async () => new Map([[process.ppid, startedAt + 600_000]]),
    )

    expect(await liveRoots()).not.toContain('/peer/dist')
    expect(await readdir(sessionsDir())).not.toContain(String(process.ppid))
  })

  test('treats clock skew within tolerance as the same process', async () => {
    const startedAt = 1_000_000
    await writeDatedEntry(process.ppid, startedAt, { root: '/peer/dist' })
    live.setProcessStartTimeProbeForTests(
      async () => new Map([[process.ppid, startedAt + 30_000]]),
    )

    expect(await liveRoots()).toContain('/peer/dist')
    expect(await readdir(sessionsDir())).toContain(String(process.ppid))
  })

  test('a start time earlier than recorded never prunes', async () => {
    const startedAt = 1_000_000
    await writeDatedEntry(process.ppid, startedAt, { root: '/peer/dist' })
    live.setProcessStartTimeProbeForTests(
      async () => new Map([[process.ppid, startedAt - 3_600_000]]),
    )

    expect(await liveRoots()).toContain('/peer/dist')
  })

  test('prunes a lease nothing has refreshed within the TTL', async () => {
    // The win32 case: `readProcessStartTimes` returns nothing there, so before
    // the TTL a stale lease whose pid had been recycled read as a live occ
    // session forever. An expired heartbeat settles it without any probe.
    await writeDatedEntry(process.ppid, 1_000_000, {
      root: '/peer/dist',
      renewedAt: Date.now() - live.LEASE_TTL_MS - 60_000,
    })
    live.setProcessStartTimeProbeForTests(async () => new Map())

    expect(await liveRoots()).not.toContain('/peer/dist')
    expect(await readdir(sessionsDir())).not.toContain(String(process.ppid))
  })

  test('a fresh heartbeat keeps a lease the probe cannot identify', async () => {
    await writeDatedEntry(process.ppid, 1_000_000, { root: '/peer/dist' })
    live.setProcessStartTimeProbeForTests(async () => new Map())

    expect(await liveRoots()).toContain('/peer/dist')
    expect(await readdir(sessionsDir())).toContain(String(process.ppid))
  })

  test('an identified process survives an expired heartbeat', async () => {
    // Timers stop while a laptop sleeps, so after a long suspend every lease
    // looks expired. Where `ps` can prove the process is the same one that
    // registered, that proof wins — pruning it would let a peer reclaim the
    // farm it is still importing chunks from.
    const startedAt = 1_000_000
    await writeDatedEntry(process.ppid, startedAt, {
      root: '/peer/dist',
      renewedAt: Date.now() - live.LEASE_TTL_MS - 3_600_000,
    })
    live.setProcessStartTimeProbeForTests(
      async () => new Map([[process.ppid, startedAt]]),
    )

    expect(await liveRoots()).toContain('/peer/dist')
    expect(await readdir(sessionsDir())).toContain(String(process.ppid))
  })

  test('falls back to the file mtime for leases written before heartbeats', async () => {
    await writeEntry(process.ppid, '/legacy/dist')
    const stale = new Date(Date.now() - live.LEASE_TTL_MS - 60_000)
    await utimes(join(sessionsDir(), String(process.ppid)), stale, stale)
    live.setProcessStartTimeProbeForTests(async () => new Map())

    expect(await liveRoots()).not.toContain('/legacy/dist')
  })

  test('an unavailable probe degrades to the TTL, not to pruning', async () => {
    await writeDatedEntry(process.ppid, 1_000_000, { root: '/peer/dist' })
    live.setProcessStartTimeProbeForTests(async () => {
      throw new Error('no ps on this platform')
    })

    expect(await liveRoots()).toContain('/peer/dist')
    expect(await readdir(sessionsDir())).toContain(String(process.ppid))
  })

  test('the real probe reports a plausible start time for this process', async () => {
    // Runs `ps` for real — this is the case that caught the `lstart` timezone
    // bug, so it must not degrade into a no-op.
    //
    // It is also the case most exposed to cross-file mock pollution: several
    // suites `mock.module('node:child_process', …)` (process-global, and
    // `node:*` is exempt from check:mock-hygiene), and one of them replaces
    // `execFile` without forwarding `[util.promisify.custom]`. The probe
    // therefore uses execFile's callback contract directly rather than
    // promisify — if someone reintroduces promisify here, this assertion goes
    // undefined in a full run while still passing on its own.
    if (process.platform === 'win32') return
    const startTimes = await live.readProcessStartTimesForTests([process.pid])
    const reported = startTimes.get(process.pid)

    expect(reported).toBeDefined()
    const expected = Date.now() - process.uptime() * 1000
    // `ps` truncates elapsed time to whole seconds.
    expect(Math.abs((reported ?? 0) - expected)).toBeLessThan(2_000)
  })
})
