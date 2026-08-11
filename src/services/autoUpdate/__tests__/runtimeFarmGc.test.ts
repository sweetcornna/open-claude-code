/**
 * Tests for the runtime-farm sweep (runtimeFarmGc.ts).
 *
 * The live-session probe, the clock and the current dist root are injected, so
 * only the log/debug leaves are mock.module'd (shared mocks, per CLAUDE.md).
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
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let gc: typeof import('../runtimeFarmGc.js')
let configDir: string
const previousConfigDir = process.env.OCC_CONFIG_DIR

const NOW = 1_800_000_000_000
const HOUR_MS = 60 * 60_000

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'occ-farm-gc-'))
  process.env.OCC_CONFIG_DIR = configDir
  gc = await import('../runtimeFarmGc.js')
})

afterAll(() => {
  if (previousConfigDir === undefined) {
    delete process.env.OCC_CONFIG_DIR
  } else {
    process.env.OCC_CONFIG_DIR = previousConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

afterEach(() => {
  gc.resetRuntimeFarmGcForTests()
  rmSync(farmsRoot(), { recursive: true, force: true })
  rmSync(join(configDir, 'pending-updates'), { recursive: true, force: true })
})

function farmsRoot(): string {
  return join(configDir, 'runtime')
}

/** A farm directory whose mtime says it was built `ageMs` ago. */
function makeFarm(name: string, ageMs = 4 * HOUR_MS): string {
  const dir = join(farmsRoot(), name)
  mkdirSync(join(dir, 'dist', 'chunks'), { recursive: true })
  const when = new Date(NOW - ageMs)
  utimesSync(dir, when, when)
  return dir
}

type Deps = import('../runtimeFarmGc.js').RuntimeFarmGcDeps

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    liveRoots: async () => ({ roots: new Set<string>(), complete: true }),
    now: () => NOW,
    currentDistRoot: '/not/a/farm/dist',
    ...overrides,
  }
}

describe('runRuntimeFarmGc', () => {
  test('reclaims a farm no live session is running from', async () => {
    const stale = makeFarm('2.36.1-aaaaaaaa')

    const removed = await gc.runRuntimeFarmGc(makeDeps())

    expect(removed).toEqual([stale])
    expect(existsSync(stale)).toBe(false)
  })

  test('never touches a farm a live session is running from', async () => {
    // Reclaiming this would strand every chunk that session has not imported
    // yet — the exact failure the farm exists to prevent.
    const inUse = makeFarm('2.36.1-aaaaaaaa')
    const stale = makeFarm('2.35.0-bbbbbbbb')

    const removed = await gc.runRuntimeFarmGc(
      makeDeps({
        liveRoots: async () => ({
          roots: new Set([join(inUse, 'dist')]),
          complete: true,
        }),
      }),
    )

    expect(removed).toEqual([stale])
    expect(existsSync(inUse)).toBe(true)
  })

  test('never touches the farm this process is running from', async () => {
    const current = makeFarm('2.37.0-cccccccc')

    const removed = await gc.runRuntimeFarmGc(
      makeDeps({ currentDistRoot: join(current, 'dist') }),
    )

    expect(removed).toEqual([])
    expect(existsSync(current)).toBe(true)
  })

  test('spares a farm younger than the grace period', async () => {
    // A session that has just built its farm has not registered its lease yet;
    // for those few hundred milliseconds no registry knows it is in use.
    const fresh = makeFarm('2.37.0-dddddddd', 30_000)

    const removed = await gc.runRuntimeFarmGc(makeDeps())

    expect(removed).toEqual([])
    expect(existsSync(fresh)).toBe(true)
  })

  test('reclaims a half-built staging directory left by a crash', async () => {
    const staging = makeFarm('.staging-abc123')

    const removed = await gc.runRuntimeFarmGc(makeDeps())

    expect(removed).toEqual([staging])
  })

  test('deletes nothing when the live-session set is incomplete', async () => {
    // A live pid whose tree could not be identified is not evidence that any
    // particular tree is unused.
    const stale = makeFarm('2.36.1-aaaaaaaa')

    const removed = await gc.runRuntimeFarmGc(
      makeDeps({
        liveRoots: async () => ({ roots: new Set<string>(), complete: false }),
      }),
    )

    expect(removed).toEqual([])
    expect(existsSync(stale)).toBe(true)
  })

  test('sweeps the retired pending-updates directory', async () => {
    // Deferred installs left one JSON candidate per discovered version and
    // never pruned them: a candidate whose distRoot is not the current one can
    // never match, so it could neither be consumed nor removed. Interrupted
    // atomic writes leaked `.tmp` files beside them.
    const pending = join(configDir, 'pending-updates')
    mkdirSync(pending, { recursive: true })
    await Bun.write(join(pending, 'abc.json'), '{}')
    await Bun.write(join(pending, 'abc.json.123.tmp'), '')

    await gc.runRuntimeFarmGc(makeDeps())

    expect(existsSync(pending)).toBe(false)
  })

  test('is a no-op, and silent, when no farms root exists', async () => {
    // The normal state of a dev checkout.
    expect(await gc.runRuntimeFarmGc(makeDeps())).toEqual([])
  })
})

describe('scheduleRuntimeFarmGc', () => {
  test('schedules one unref-ed sweep per session', async () => {
    const tasks: { delayMs: number; unrefed: boolean }[] = []
    let runs = 0
    const scheduleFn = (callback: () => Promise<void>, delayMs: number) => {
      const task = { delayMs, unrefed: false, callback }
      tasks.push(task)
      return {
        unref: () => {
          task.unrefed = true
        },
      }
    }

    const first = gc.scheduleRuntimeFarmGc({
      run: async () => {
        runs++
      },
      scheduleFn,
    })
    const second = gc.scheduleRuntimeFarmGc({
      run: async () => {
        runs++
      },
      scheduleFn,
    })

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.delayMs).toBe(90_000)
    // Housekeeping must never be the reason a process stays alive.
    expect(tasks[0]?.unrefed).toBe(true)
    expect(runs).toBe(0)
  })
})
