/**
 * Tests for the silent background self-updater (backgroundOccUpdate.ts) and
 * its notifier registry (updateNotifier.ts).
 *
 * The service takes its whole side-effecting chain (npm view / install -g /
 * config / installation detection) through injected deps, so these tests
 * exercise the full flow with fakes and only mock.module the log/debug leaf
 * modules (shared mocks, per CLAUDE.md mock discipline). No business module
 * is mocked — nothing here can pollute other test files' module registry
 * beyond the always-mocked telemetry leaves.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

// Lazy imports so the modules resolve after the mock.module calls above.
let updater: typeof import('../backgroundOccUpdate.js')
let intervalMod: typeof import('../backgroundUpdateInterval.js')
let notifierMod: typeof import('../updateNotifier.js')

beforeAll(async () => {
  updater = await import('../backgroundOccUpdate.js')
  intervalMod = await import('../backgroundUpdateInterval.js')
  notifierMod = await import('../updateNotifier.js')
})

afterEach(() => {
  updater.resetBackgroundOccUpdateForTests()
  notifierMod.resetBackgroundUpdateNotifierForTests()
})

type Deps = import('../backgroundOccUpdate.js').BackgroundOccUpdateDeps

type Queued = import('../deferredOccInstall.js').DeferredOccInstall

type Calls = {
  /** Installs handed to deferredOccInstall — nothing installs in-session. */
  queued: Queued[]
  notified: string[]
  latestChecks: number
  installTypeChecks: number
  checkClaims: Array<{
    checkedAt: number
    minimumElapsedMs: number
  }>
}

function makeDeps(overrides: Partial<Deps> = {}): {
  deps: Deps
  calls: Calls
} {
  const calls: Calls = {
    queued: [],
    notified: [],
    latestChecks: 0,
    installTypeChecks: 0,
    checkClaims: [],
  }
  const deps: Deps = {
    env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
    getAutoUpdatesConfig: () => undefined,
    getEssentialTrafficOnlyReason: () => null,
    getInstallationType: async () => {
      calls.installTypeChecks++
      return 'npm-global'
    },
    isBunGlobalInstall: () => false,
    getCurrentVersion: () => '1.0.0',
    getLatestVersion: async () => {
      calls.latestChecks++
      return '1.1.0'
    },
    armInstall: async install => {
      calls.queued.push(install)
    },
    packageSpec: () => '@scope/pkg@latest',
    notify: text => {
      calls.notified.push(text)
    },
    now: () => 1_000_000,
    claimUpdateCheck: (checkedAt, minimumElapsedMs) => {
      calls.checkClaims.push({ checkedAt, minimumElapsedMs })
      return true
    },
    ...overrides,
  }
  return { deps, calls }
}

type Outcome = import('../backgroundOccUpdate.js').BackgroundOccUpdateOutcome

type ScheduledTask = {
  callback: () => Promise<void>
  delayMs: number
  unrefed: boolean
}

function makeScheduler(): {
  tasks: ScheduledTask[]
  scheduleFn: (
    callback: () => Promise<void>,
    delayMs: number,
  ) => { unref: () => void }
} {
  const tasks: ScheduledTask[] = []
  return {
    tasks,
    scheduleFn: (callback, delayMs) => {
      const task = { callback, delayMs, unrefed: false }
      tasks.push(task)
      return {
        unref: () => {
          task.unrefed = true
        },
      }
    },
  }
}

describe('runBackgroundOccUpdateOnce', () => {
  test('queues an npm-global install for exit and notifies once', async () => {
    const { deps, calls } = makeDeps()
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'queued', version: '1.1.0' })
    // Nothing is installed in-session: replacing the tree under a running
    // process strands half its lazily imported chunks.
    expect(calls.queued).toEqual([
      {
        pkgManager: 'npm',
        spec: '@scope/pkg@latest',
        version: '1.1.0',
      },
    ])
    expect(calls.notified).toEqual(['✓ Update v1.1.0 ready · installs on exit'])
    expect(calls.checkClaims).toEqual([
      { checkedAt: 1_000_000, minimumElapsedMs: 1_620_000 },
    ])
  })

  test('queues a bun global install via bun without probing npm install type', async () => {
    const { deps, calls } = makeDeps({ isBunGlobalInstall: () => true })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'queued', version: '1.1.0' })
    expect(calls.queued.map(q => q.pkgManager)).toEqual(['bun'])
    // bun path check short-circuits the (subprocess-spawning) type detection
    expect(calls.installTypeChecks).toBe(0)
  })

  test('skips when DISABLE_AUTOUPDATER is set, before any network check', async () => {
    const { deps, calls } = makeDeps({
      env: {
        NODE_ENV: 'production',
        DISABLE_AUTOUPDATER: '1',
      } as unknown as NodeJS.ProcessEnv,
    })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome.status).toBe('skipped')
    expect(calls.latestChecks).toBe(0)
    expect(calls.queued).toEqual([])
  })

  test('skips when globalConfig.autoUpdates === false', async () => {
    const { deps, calls } = makeDeps({ getAutoUpdatesConfig: () => false })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'autoUpdates disabled in global config',
      // Reversible: the user can flip this back on with /config mid-session.
      permanent: false,
    })
    expect(calls.latestChecks).toBe(0)
  })

  test('runs when autoUpdates is undefined (default-enabled)', async () => {
    const { deps } = makeDeps({ getAutoUpdatesConfig: () => undefined })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)
    expect(outcome.status).toBe('queued')
  })

  test('skips under essential-traffic-only env', async () => {
    const { deps, calls } = makeDeps({
      getEssentialTrafficOnlyReason: () =>
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set',
      permanent: false,
    })
    expect(calls.latestChecks).toBe(0)
  })

  test.each([
    'test',
    'development',
  ] as const)('skips when NODE_ENV=%s', async nodeEnv => {
    const { deps, calls } = makeDeps({
      env: { NODE_ENV: nodeEnv } as NodeJS.ProcessEnv,
    })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome.status).toBe('skipped')
    expect(calls.latestChecks).toBe(0)
  })

  test.each([
    'development',
    'npm-local',
    'package-manager',
    'unknown',
  ] as const)('skips non-global installation type %s', async installType => {
    const { deps, calls } = makeDeps({
      getInstallationType: async () => installType,
    })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({
      status: 'skipped',
      reason: `not a global install (${installType})`,
      // How occ was installed cannot change while it is running.
      permanent: true,
    })
    expect(calls.queued).toEqual([])
    expect(calls.notified).toEqual([])
  })

  test('does nothing when already up to date (equal or newer)', async () => {
    for (const latest of ['1.0.0', '0.9.9']) {
      const { deps, calls } = makeDeps({ getLatestVersion: async () => latest })
      const outcome = await updater.runBackgroundOccUpdateOnce(deps)

      expect(outcome).toEqual({ status: 'up-to-date', version: '1.0.0' })
      expect(calls.queued).toEqual([])
      expect(calls.notified).toEqual([])
    }
  })

  test('reports check-failed silently when the registry is unreachable', async () => {
    const { deps, calls } = makeDeps({ getLatestVersion: async () => null })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'check-failed' })
    expect(calls.queued).toEqual([])
    expect(calls.notified).toEqual([])
  })

  test('throttles a recent persisted check before hitting the registry', async () => {
    const now = 1_000_000
    const persisted = now - 60_000
    const { deps, calls } = makeDeps({
      now: () => now,
      claimUpdateCheck: (checkedAt, minimumElapsedMs) =>
        checkedAt - persisted >= minimumElapsedMs,
    })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'throttled' })
    expect(calls.latestChecks).toBe(0)
    expect(calls.queued).toEqual([])
  })

  test('queues without taking the exit-time update lock', async () => {
    const { deps, calls } = makeDeps()
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'queued', version: '1.1.0' })
    expect(calls.queued).toHaveLength(1)
  })

  test('a throwing dependency yields error status and never throws', async () => {
    const { deps, calls } = makeDeps({
      armInstall: () => {
        throw new Error('registration failure')
      },
    })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'error' })
    expect(calls.notified).toEqual([])
  })

  test('uses the last queued version as the next comparison baseline', async () => {
    let latestVersion = '1.1.0'
    const { deps, calls } = makeDeps({
      getLatestVersion: async () => latestVersion,
    })

    expect(await updater.runBackgroundOccUpdateOnce(deps)).toEqual({
      status: 'queued',
      version: '1.1.0',
    })
    // Without the baseline, every 30-minute pass would re-queue and re-notify
    // the same release for the rest of the session.
    expect(await updater.runBackgroundOccUpdateOnce(deps)).toEqual({
      status: 'up-to-date',
      version: '1.1.0',
    })

    latestVersion = '1.2.0'
    expect(await updater.runBackgroundOccUpdateOnce(deps)).toEqual({
      status: 'queued',
      version: '1.2.0',
    })
    expect(calls.queued.map(q => q.version)).toEqual(['1.1.0', '1.2.0'])
    expect(calls.notified).toHaveLength(2)
  })
})

describe('maybeScheduleBackgroundOccUpdate', () => {
  const prodEnv = { NODE_ENV: 'production' } as NodeJS.ProcessEnv

  test('installs one loop and schedules again only after a run finishes', async () => {
    const scheduler = makeScheduler()
    const ignoredScheduler = makeScheduler()
    let runs = 0
    let finishRun!: (outcome: Outcome) => void
    const runResult = new Promise<Outcome>(resolve => {
      finishRun = resolve
    })

    const first = updater.maybeScheduleBackgroundOccUpdate({
      env: {
        ...prodEnv,
        OCC_UPDATE_CHECK_INTERVAL_MS: '120000',
      },
      run: async () => {
        runs++
        return runResult
      },
      scheduleFn: scheduler.scheduleFn,
    })
    const second = updater.maybeScheduleBackgroundOccUpdate({
      env: prodEnv,
      run: async () => ({ status: 'check-failed' }),
      scheduleFn: ignoredScheduler.scheduleFn,
    })

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(ignoredScheduler.tasks).toHaveLength(0)
    expect(scheduler.tasks).toHaveLength(1)
    expect(scheduler.tasks[0]?.delayMs).toBe(60 * 1000)
    expect(scheduler.tasks[0]?.unrefed).toBe(true)

    const firing = scheduler.tasks[0]!.callback()
    expect(runs).toBe(1)
    expect(scheduler.tasks).toHaveLength(1)

    finishRun({ status: 'up-to-date', version: '1.0.0' })
    await firing
    expect(scheduler.tasks).toHaveLength(2)
    expect(scheduler.tasks[1]?.delayMs).toBe(120_000)
    expect(scheduler.tasks[1]?.unrefed).toBe(true)
  })

  test('aborting the controller cancels the spawns and stops the loop', async () => {
    // The timers are unref'd, but the spawned `npm view` child is not: without
    // a cancel path, Ctrl+C mid-check waited out gracefulShutdown's failsafe
    // and then hard-exited.
    const controller = new AbortController()
    const scheduler = makeScheduler()
    const seenSignals: AbortSignal[] = []
    updater.maybeScheduleBackgroundOccUpdate({
      env: prodEnv,
      abortController: controller,
      run: async signal => {
        seenSignals.push(signal)
        return { status: 'up-to-date', version: '1.0.0' }
      },
      scheduleFn: scheduler.scheduleFn,
    })

    await scheduler.tasks[0]!.callback()
    expect(seenSignals).toHaveLength(1)
    expect(seenSignals[0]).toBe(controller.signal)
    expect(scheduler.tasks).toHaveLength(2)

    // A tick that fires after shutdown started must not begin new work.
    controller.abort()
    await scheduler.tasks[1]!.callback()
    expect(seenSignals).toHaveLength(1)
    expect(scheduler.tasks).toHaveLength(2)
  })

  test('the runner hands its signal to the version check', async () => {
    const controller = new AbortController()
    const seen: Array<AbortSignal | undefined> = []
    const { deps } = makeDeps({
      getLatestVersion: async signal => {
        seen.push(signal)
        return '1.1.0'
      },
    })

    await updater.runBackgroundOccUpdateOnce(deps, controller.signal)

    // `npm view` is the only child this loop spawns now.
    expect(seen).toEqual([controller.signal])
  })

  test('stops the loop after a permanent skipped outcome', async () => {
    const scheduler = makeScheduler()
    updater.maybeScheduleBackgroundOccUpdate({
      env: prodEnv,
      run: async () => ({
        status: 'skipped',
        reason: 'not a global install (npm-local)',
        permanent: true,
      }),
      scheduleFn: scheduler.scheduleFn,
    })

    await scheduler.tasks[0]!.callback()
    expect(scheduler.tasks).toHaveLength(1)
  })

  test('keeps looping after a reversible skip so re-enabling takes effect live', async () => {
    // `/config` can turn autoUpdates back on mid-session. Retiring the loop on
    // that skip meant the setting silently did nothing until the next launch.
    const scheduler = makeScheduler()
    updater.maybeScheduleBackgroundOccUpdate({
      env: prodEnv,
      run: async () => ({
        status: 'skipped',
        reason: 'autoUpdates disabled in global config',
        permanent: false,
      }),
      scheduleFn: scheduler.scheduleFn,
    })

    await scheduler.tasks[0]!.callback()
    expect(scheduler.tasks).toHaveLength(2)
    // Back on the normal interval, not the short first-check delay.
    expect(scheduler.tasks[1]?.delayMs).toBe(1_800_000)
  })

  test.each([
    { status: 'check-failed' } as Outcome,
    { status: 'throttled' } as Outcome,
  ])('continues the loop after $status', async outcome => {
    const scheduler = makeScheduler()
    updater.maybeScheduleBackgroundOccUpdate({
      env: prodEnv,
      run: async () => outcome,
      scheduleFn: scheduler.scheduleFn,
    })

    await scheduler.tasks[0]!.callback()
    expect(scheduler.tasks).toHaveLength(2)
  })

  test('does not schedule under NODE_ENV=test or with DISABLE_AUTOUPDATER', () => {
    const scheduler = makeScheduler()
    expect(
      updater.maybeScheduleBackgroundOccUpdate({
        env: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
        run: async () => ({ status: 'error' }),
        scheduleFn: scheduler.scheduleFn,
      }),
    ).toBe(false)

    expect(
      updater.maybeScheduleBackgroundOccUpdate({
        env: {
          NODE_ENV: 'production',
          DISABLE_AUTOUPDATER: 'true',
        } as unknown as NodeJS.ProcessEnv,
        run: async () => ({ status: 'error' }),
        scheduleFn: scheduler.scheduleFn,
      }),
    ).toBe(false)
    expect(scheduler.tasks).toHaveLength(0)

    // Neither refusal consumed the per-session slot.
    expect(
      updater.maybeScheduleBackgroundOccUpdate({
        env: prodEnv,
        run: async () => ({ status: 'up-to-date', version: '1.0.0' }),
        scheduleFn: scheduler.scheduleFn,
      }),
    ).toBe(true)
    expect(scheduler.tasks).toHaveLength(1)
  })

  test('a rejecting run is swallowed (logged, not unhandled)', async () => {
    const scheduler = makeScheduler()
    updater.maybeScheduleBackgroundOccUpdate({
      env: prodEnv,
      run: async () => {
        throw new Error('boom')
      },
      scheduleFn: scheduler.scheduleFn,
    })

    await scheduler.tasks[0]!.callback()
    expect(scheduler.tasks).toHaveLength(2)
  })
})

describe('resolveBackgroundUpdateIntervalMs', () => {
  test('uses the default for missing or invalid values', () => {
    expect(intervalMod.resolveBackgroundUpdateIntervalMs({})).toBe(1_800_000)
    expect(
      intervalMod.resolveBackgroundUpdateIntervalMs({
        OCC_UPDATE_CHECK_INTERVAL_MS: 'not-a-number',
      }),
    ).toBe(1_800_000)
  })

  test('clamps low values and accepts a valid override', () => {
    expect(
      intervalMod.resolveBackgroundUpdateIntervalMs({
        OCC_UPDATE_CHECK_INTERVAL_MS: '1000',
      }),
    ).toBe(60_000)
    expect(
      intervalMod.resolveBackgroundUpdateIntervalMs({
        OCC_UPDATE_CHECK_INTERVAL_MS: '600000',
      }),
    ).toBe(600_000)
  })
})

describe('updateNotifier', () => {
  test('delivers directly when a notifier is registered', () => {
    const received: string[] = []
    notifierMod.setBackgroundUpdateNotifier(text => received.push(text))
    notifierMod.emitBackgroundUpdateNotification('hello')
    expect(received).toEqual(['hello'])
  })

  test('buffers when no notifier is registered and flushes once on registration', () => {
    notifierMod.emitBackgroundUpdateNotification('buffered')

    const received: string[] = []
    notifierMod.setBackgroundUpdateNotifier(text => received.push(text))
    expect(received).toEqual(['buffered'])

    // Re-registering (e.g. component remount) must not replay the notice.
    const later: string[] = []
    notifierMod.setBackgroundUpdateNotifier(text => later.push(text))
    expect(later).toEqual([])
  })

  test('unregistering (null) returns to buffering mode', () => {
    const received: string[] = []
    notifierMod.setBackgroundUpdateNotifier(text => received.push(text))
    notifierMod.setBackgroundUpdateNotifier(null)

    notifierMod.emitBackgroundUpdateNotification('while unmounted')
    expect(received).toEqual([])

    notifierMod.setBackgroundUpdateNotifier(text => received.push(text))
    expect(received).toEqual(['while unmounted'])
  })
})
