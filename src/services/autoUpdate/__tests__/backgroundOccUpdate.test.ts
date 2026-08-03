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
let notifierMod: typeof import('../updateNotifier.js')

beforeAll(async () => {
  updater = await import('../backgroundOccUpdate.js')
  notifierMod = await import('../updateNotifier.js')
})

afterEach(() => {
  updater.resetBackgroundOccUpdateForTests()
  notifierMod.resetBackgroundUpdateNotifierForTests()
})

type Deps = import('../backgroundOccUpdate.js').BackgroundOccUpdateDeps

type Calls = {
  installed: Array<'bun' | 'npm'>
  notified: string[]
  latestChecks: number
  installTypeChecks: number
  lockAcquired: number
  lockReleased: number
}

function makeDeps(overrides: Partial<Deps> = {}): {
  deps: Deps
  calls: Calls
} {
  const calls: Calls = {
    installed: [],
    notified: [],
    latestChecks: 0,
    installTypeChecks: 0,
    lockAcquired: 0,
    lockReleased: 0,
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
    installLatest: async pkgManager => {
      calls.installed.push(pkgManager)
      return { ok: true, detail: '' }
    },
    acquireLock: async () => {
      calls.lockAcquired++
      return true
    },
    releaseLock: async () => {
      calls.lockReleased++
    },
    notify: text => {
      calls.notified.push(text)
    },
    ...overrides,
  }
  return { deps, calls }
}

describe('runBackgroundOccUpdateOnce', () => {
  test('updates an npm-global install via npm and notifies once', async () => {
    const { deps, calls } = makeDeps()
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'updated', version: '1.1.0' })
    expect(calls.installed).toEqual(['npm'])
    expect(calls.notified).toEqual(['✓ Updated to v1.1.0 · Restart to apply'])
    expect(calls.lockAcquired).toBe(1)
    expect(calls.lockReleased).toBe(1)
  })

  test('updates a bun global install via bun without probing npm install type', async () => {
    const { deps, calls } = makeDeps({ isBunGlobalInstall: () => true })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'updated', version: '1.1.0' })
    expect(calls.installed).toEqual(['bun'])
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
    expect(calls.installed).toEqual([])
  })

  test('skips when globalConfig.autoUpdates === false', async () => {
    const { deps, calls } = makeDeps({ getAutoUpdatesConfig: () => false })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'autoUpdates disabled in global config',
    })
    expect(calls.latestChecks).toBe(0)
  })

  test('runs when autoUpdates is undefined (default-enabled)', async () => {
    const { deps } = makeDeps({ getAutoUpdatesConfig: () => undefined })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)
    expect(outcome.status).toBe('updated')
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
    })
    expect(calls.installed).toEqual([])
    expect(calls.notified).toEqual([])
  })

  test('does nothing when already up to date (equal or newer)', async () => {
    for (const latest of ['1.0.0', '0.9.9']) {
      const { deps, calls } = makeDeps({ getLatestVersion: async () => latest })
      const outcome = await updater.runBackgroundOccUpdateOnce(deps)

      expect(outcome).toEqual({ status: 'up-to-date', version: '1.0.0' })
      expect(calls.installed).toEqual([])
      expect(calls.notified).toEqual([])
      expect(calls.lockAcquired).toBe(0)
    }
  })

  test('reports check-failed silently when the registry is unreachable', async () => {
    const { deps, calls } = makeDeps({ getLatestVersion: async () => null })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'check-failed' })
    expect(calls.installed).toEqual([])
    expect(calls.notified).toEqual([])
  })

  test('backs off without installing when the update lock is held', async () => {
    const { deps, calls } = makeDeps({ acquireLock: async () => false })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'locked' })
    expect(calls.installed).toEqual([])
    // Lock was never acquired, so it must not be released either.
    expect(calls.lockReleased).toBe(0)
  })

  test('install failure stays silent (no notification) and releases the lock', async () => {
    const { deps, calls } = makeDeps({
      installLatest: async () => ({ ok: false, detail: 'EACCES' }),
    })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'install-failed' })
    expect(calls.notified).toEqual([])
    expect(calls.lockReleased).toBe(1)
  })

  test('a throwing dependency yields error status, releases the lock, never throws', async () => {
    const { deps, calls } = makeDeps({
      installLatest: async () => {
        throw new Error('spawn failure')
      },
    })
    const outcome = await updater.runBackgroundOccUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'error' })
    expect(calls.lockReleased).toBe(1)
    expect(calls.notified).toEqual([])
  })
})

describe('maybeScheduleBackgroundOccUpdate', () => {
  const prodEnv = { NODE_ENV: 'production' } as NodeJS.ProcessEnv

  test('schedules at most once per session and runs the check', async () => {
    let runs = 0
    let resolveRan: () => void
    const ran = new Promise<void>(resolve => {
      resolveRan = resolve
    })

    const first = updater.maybeScheduleBackgroundOccUpdate({
      env: prodEnv,
      delayMs: 1,
      run: async () => {
        runs++
        resolveRan()
      },
    })
    const second = updater.maybeScheduleBackgroundOccUpdate({
      env: prodEnv,
      delayMs: 1,
      run: async () => {
        runs++
      },
    })

    expect(first).toBe(true)
    expect(second).toBe(false)
    await ran
    expect(runs).toBe(1)
  })

  test('does not schedule under NODE_ENV=test or with DISABLE_AUTOUPDATER', () => {
    expect(
      updater.maybeScheduleBackgroundOccUpdate({
        env: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
        delayMs: 1,
        run: async () => {
          throw new Error('must not run')
        },
      }),
    ).toBe(false)

    expect(
      updater.maybeScheduleBackgroundOccUpdate({
        env: {
          NODE_ENV: 'production',
          DISABLE_AUTOUPDATER: 'true',
        } as unknown as NodeJS.ProcessEnv,
        delayMs: 1,
        run: async () => {
          throw new Error('must not run')
        },
      }),
    ).toBe(false)

    // Neither refusal consumed the per-session slot.
    expect(
      updater.maybeScheduleBackgroundOccUpdate({
        env: prodEnv,
        delayMs: 60_000,
        run: async () => {},
      }),
    ).toBe(true)
  })

  test('a rejecting run is swallowed (logged, not unhandled)', async () => {
    let resolveRan: () => void
    const ran = new Promise<void>(resolve => {
      resolveRan = resolve
    })
    updater.maybeScheduleBackgroundOccUpdate({
      env: prodEnv,
      delayMs: 1,
      run: async () => {
        // Resolve on a microtask after the rejection propagates through the
        // .catch in the scheduler; an unhandled rejection would fail the run.
        queueMicrotask(() => queueMicrotask(resolveRan))
        throw new Error('boom')
      },
    })
    await ran
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
