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
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
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

/** A lease in the current format, carrying the start time of the process. */
async function writeDatedEntry(
  pid: number,
  startedAt: number,
  root = distRootValue,
): Promise<void> {
  await mkdir(sessionsDir(), { recursive: true })
  await writeFile(
    join(sessionsDir(), String(pid)),
    JSON.stringify({ schemaVersion: 1, distRoot: root, startedAt }),
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

describe('registerLiveSession', () => {
  test('does not resolve until this process lease is visible', async () => {
    await live.registerLiveSession()

    const entry = join(sessionsDir(), String(process.pid))
    expect(existsSync(entry)).toBe(true)
    // The lease carries the dist root plus this process's start time; see the
    // dedicated assertion on the start time below.
    expect(
      (JSON.parse(await readFile(entry, 'utf8')) as { distRoot: string })
        .distRoot,
    ).toBe(distRootValue)
  })

  test('removes its lease before handing off a deferred install', async () => {
    const entry = join(sessionsDir(), String(process.pid))
    let leaseVisibleDuringHandoff: boolean | undefined
    await live.registerLiveSession(async () => {
      leaseVisibleDuringHandoff = existsSync(entry)
    })

    await cleanupRegistry.runCleanupFunctions()

    expect(leaseVisibleDuringHandoff).toBe(false)
    expect(existsSync(entry)).toBe(false)
  })

  test('registering without a handler runs no handoff at exit', async () => {
    // The --print path: visible to peer sessions so they postpone replacing the
    // tree, but never the process that spawns an installer.
    await live.registerLiveSession()

    await cleanupRegistry.runCleanupFunctions()

    expect(existsSync(join(sessionsDir(), String(process.pid)))).toBe(false)
  })

  test('a handler attached after registration still runs at exit', async () => {
    // rootAction only knows the session is interactive after the --print early
    // return, which is well past the point where the lease has to exist.
    await live.registerLiveSession()
    let handoffs = 0
    live.setLiveSessionExitHandler(async () => {
      handoffs++
    })

    await cleanupRegistry.runCleanupFunctions()

    expect(handoffs).toBe(1)
  })

  test('records this process start time in its own lease', async () => {
    await live.registerLiveSession()

    const raw = await readFile(join(sessionsDir(), String(process.pid)), 'utf8')
    const lease = JSON.parse(raw) as {
      distRoot: string
      startedAt: number
    }

    expect(lease.distRoot).toBe(distRootValue)
    const expected = Date.now() - process.uptime() * 1000
    expect(Math.abs(lease.startedAt - expected)).toBeLessThan(2_000)
  })
})

describe('hasOtherLiveSessions', () => {
  test('is false when the registry does not exist yet', async () => {
    expect(await live.hasOtherLiveSessions()).toBe(false)
  })

  test('ignores this process own entry', async () => {
    await writeEntry(process.pid)
    expect(await live.hasOtherLiveSessions()).toBe(false)
  })

  test('reports another live process on the same dist root', async () => {
    // process.ppid is alive by construction and is not us.
    await writeEntry(process.ppid)
    expect(await live.hasOtherLiveSessions()).toBe(true)
  })

  test('ignores a live process running from a different dist root', async () => {
    // A `bun run dev` checkout is unaffected by replacing the global install.
    await writeEntry(process.ppid, '/somewhere/else/dist')
    expect(await live.hasOtherLiveSessions()).toBe(false)
  })

  test('prunes entries whose process is gone, so a crash cannot block updates', async () => {
    const gone = deadPid()
    await writeEntry(gone)

    expect(await live.hasOtherLiveSessions()).toBe(false)
    expect(await readdir(sessionsDir())).not.toContain(String(gone))
  })

  test('a malformed filename is ignored rather than throwing', async () => {
    await mkdir(sessionsDir(), { recursive: true })
    await writeFile(join(sessionsDir(), 'not-a-pid'), distRootValue, 'utf8')
    expect(await live.hasOtherLiveSessions()).toBe(false)
  })

  test('still honours a legacy lease that has no start time', async () => {
    // A session registered by the previous build must keep blocking installs
    // for as long as it runs — it is reading chunks out of the tree.
    await writeEntry(process.ppid)
    live.setProcessStartTimeProbeForTests(async () => new Map())
    expect(await live.hasOtherLiveSessions()).toBe(true)
  })

  test('reports a live process whose recorded start time matches', async () => {
    const startedAt = 1_000_000
    await writeDatedEntry(process.ppid, startedAt)
    live.setProcessStartTimeProbeForTests(async pids => {
      expect(pids).toEqual([process.ppid])
      return new Map([[process.ppid, startedAt]])
    })

    expect(await live.hasOtherLiveSessions()).toBe(true)
    expect(await readdir(sessionsDir())).toContain(String(process.ppid))
  })

  test('prunes a lease whose pid was recycled onto a newer process', async () => {
    // The regression: a `-p` session SIGKILLed before cleanup leaves its lease
    // behind. Once the OS hands that pid to something unrelated, the lease
    // reads as permanently live and auto-updates for this dist root stop for
    // good — silently, because every failure path here is swallowed.
    const startedAt = 1_000_000
    await writeDatedEntry(process.ppid, startedAt)
    live.setProcessStartTimeProbeForTests(
      async () => new Map([[process.ppid, startedAt + 600_000]]),
    )

    expect(await live.hasOtherLiveSessions()).toBe(false)
    expect(await readdir(sessionsDir())).not.toContain(String(process.ppid))
  })

  test('treats clock skew within tolerance as the same process', async () => {
    // A wall-clock step between registration and this check must not read as
    // reuse: pruning a live lease is the accident this registry exists to stop.
    const startedAt = 1_000_000
    await writeDatedEntry(process.ppid, startedAt)
    live.setProcessStartTimeProbeForTests(
      async () => new Map([[process.ppid, startedAt + 30_000]]),
    )

    expect(await live.hasOtherLiveSessions()).toBe(true)
    expect(await readdir(sessionsDir())).toContain(String(process.ppid))
  })

  test('a start time earlier than recorded never prunes', async () => {
    // Only a *later* start proves reuse. Anything else (an NTP step, a probe
    // that disagrees) must fail safe: pruning a live session's lease is what
    // lets an install replace the tree it is still importing from.
    const startedAt = 1_000_000
    await writeDatedEntry(process.ppid, startedAt)
    live.setProcessStartTimeProbeForTests(
      async () => new Map([[process.ppid, startedAt - 3_600_000]]),
    )

    expect(await live.hasOtherLiveSessions()).toBe(true)
  })

  test('an unavailable probe degrades to pid-resolves-means-alive', async () => {
    await writeDatedEntry(process.ppid, 1_000_000)
    live.setProcessStartTimeProbeForTests(async () => {
      throw new Error('no ps on this platform')
    })

    expect(await live.hasOtherLiveSessions()).toBe(true)
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
    // `ps` truncates lstart to whole seconds.
    expect(Math.abs((reported ?? 0) - expected)).toBeLessThan(2_000)
  })
})
