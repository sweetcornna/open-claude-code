/**
 * Tests for the silent background plugin-marketplace updater
 * (backgroundPluginUpdate.ts) and its notifier registry
 * (pluginUpdateNotifier.ts).
 *
 * Same discipline as backgroundOccUpdate.test.ts: the service takes its whole
 * side-effecting chain (marketplace listing / git / plugin re-materialization
 * / cache invalidation / cross-process lock) through injected deps, so these
 * tests exercise the real control flow with fakes and only mock.module the
 * log/debug leaf modules (shared mocks, per CLAUDE.md mock discipline). No
 * business module is mocked — nothing here can pollute other test files'
 * module registry beyond the always-mocked telemetry leaves.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

// Lazy imports so the modules resolve after the mock.module calls above.
let updater: typeof import('../backgroundPluginUpdate.js')
let notifierMod: typeof import('../pluginUpdateNotifier.js')

beforeAll(async () => {
  updater = await import('../backgroundPluginUpdate.js')
  notifierMod = await import('../pluginUpdateNotifier.js')
})

afterEach(() => {
  updater.resetBackgroundPluginUpdateForTests()
  notifierMod.resetPluginUpdateNotifierForTests()
})

type Deps = import('../backgroundPluginUpdate.js').BackgroundPluginUpdateDeps
type Target = import('../backgroundPluginUpdate.js').MarketplaceGitTarget

type Calls = {
  listed: number
  pulled: string[]
  headReads: string[]
  pluginUpdates: Array<Set<string>>
  invalidations: number
  notified: string[]
  lockAcquired: number
  lockReleased: number
  checkClaims: Array<{
    checkedAt: number
    minimumElapsedMs: number
  }>
}

/**
 * A fake git world: every marketplace has a HEAD, and `advanceTo` decides
 * whether a successful pull moves it. Default: one marketplace whose HEAD
 * never moves (the overwhelmingly common case — nothing new upstream).
 */
function makeDeps(
  overrides: Partial<Deps> = {},
  world: {
    targets?: Target[]
    /** marketplace name -> HEAD sha after a successful pull */
    advanceTo?: Record<string, string>
    /** marketplace names whose pull fails */
    failPull?: string[]
  } = {},
): { deps: Deps; calls: Calls } {
  const targets = world.targets ?? [
    { name: 'acme', installLocation: '/cache/marketplaces/acme' },
  ]
  const heads = new Map<string, string>(targets.map(t => [t.name, 'sha-old']))
  const byLocation = new Map(targets.map(t => [t.installLocation, t]))

  const calls: Calls = {
    listed: 0,
    pulled: [],
    headReads: [],
    pluginUpdates: [],
    invalidations: 0,
    notified: [],
    lockAcquired: 0,
    lockReleased: 0,
    checkClaims: [],
  }

  const deps: Deps = {
    env: { NODE_ENV: 'production' } as NodeJS.ProcessEnv,
    getAutoUpdatesConfig: () => undefined,
    getEssentialTrafficOnlyReason: () => null,
    listGitMarketplaces: async () => {
      calls.listed++
      return targets
    },
    isGitRepo: () => true,
    readHeadSha: async dir => {
      calls.headReads.push(dir)
      const target = byLocation.get(dir)
      return target ? (heads.get(target.name) ?? null) : null
    },
    pull: async target => {
      calls.pulled.push(target.name)
      if (world.failPull?.includes(target.name)) {
        return { ok: false, detail: 'fatal: could not read Username' }
      }
      const next = world.advanceTo?.[target.name]
      if (next) {
        heads.set(target.name, next)
      }
      return { ok: true, detail: '' }
    },
    updateInstalledPlugins: async names => {
      calls.pluginUpdates.push(names)
      return [...names].map(n => `tool@${n}`)
    },
    invalidateCaches: () => {
      calls.invalidations++
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
    now: () => 1_000_000,
    claimUpdateCheck: (checkedAt, minimumElapsedMs) => {
      calls.checkClaims.push({ checkedAt, minimumElapsedMs })
      return true
    },
    ...overrides,
  }
  return { deps, calls }
}

type Outcome =
  import('../backgroundPluginUpdate.js').BackgroundPluginUpdateOutcome

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

describe('runBackgroundPluginUpdateOnce — gating', () => {
  test.each([
    'test',
    'development',
  ] as const)('skips when NODE_ENV=%s, before listing anything', async nodeEnv => {
    const { deps, calls } = makeDeps({
      env: { NODE_ENV: nodeEnv } as NodeJS.ProcessEnv,
    })
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({
      status: 'skipped',
      reason: `NODE_ENV=${nodeEnv}`,
      // Cannot change while the process runs — this one retires the loop.
      permanent: true,
    })
    expect(calls.listed).toBe(0)
    expect(calls.pulled).toEqual([])
  })

  test('skips when DISABLE_AUTOUPDATER is set', async () => {
    const { deps, calls } = makeDeps({
      env: {
        NODE_ENV: 'production',
        DISABLE_AUTOUPDATER: '1',
      } as unknown as NodeJS.ProcessEnv,
    })
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'DISABLE_AUTOUPDATER is set',
      permanent: false,
    })
    expect(calls.listed).toBe(0)
  })

  test('skips under essential-traffic-only env', async () => {
    const { deps, calls } = makeDeps({
      getEssentialTrafficOnlyReason: () =>
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    })
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set',
      permanent: false,
    })
    expect(calls.listed).toBe(0)
  })

  test('skips when globalConfig.autoUpdates === false', async () => {
    const { deps, calls } = makeDeps({ getAutoUpdatesConfig: () => false })
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'autoUpdates disabled in global config',
      permanent: false,
    })
    expect(calls.listed).toBe(0)
  })

  test('runs when autoUpdates is undefined (default-enabled)', async () => {
    const { deps, calls } = makeDeps()
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome.status).toBe('up-to-date')
    expect(calls.listed).toBe(1)
    expect(calls.checkClaims).toEqual([
      { checkedAt: 1_000_000, minimumElapsedMs: 1_620_000 },
    ])
  })

  test('no git-backed marketplaces: returns early without taking the lock', async () => {
    const { deps, calls } = makeDeps({}, { targets: [] })
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'no-marketplaces' })
    expect(calls.lockAcquired).toBe(0)
    expect(calls.notified).toEqual([])
  })

  test('throttles a recent persisted check before listing marketplaces', async () => {
    const now = 1_000_000
    const persisted = now - 60_000
    const { deps, calls } = makeDeps({
      now: () => now,
      claimUpdateCheck: (checkedAt, minimumElapsedMs) =>
        checkedAt - persisted >= minimumElapsedMs,
    })
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'throttled' })
    expect(calls.listed).toBe(0)
    expect(calls.lockAcquired).toBe(0)
  })
})

describe('runBackgroundPluginUpdateOnce — HEAD movement', () => {
  test('fetch with nothing new is completely silent', async () => {
    const { deps, calls } = makeDeps()
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'up-to-date', checked: 1 })
    expect(calls.pulled).toEqual(['acme'])
    // HEAD never moved: no cache churn, no plugin work, no notification.
    expect(calls.notified).toEqual([])
    expect(calls.invalidations).toBe(0)
    expect(calls.pluginUpdates).toEqual([])
    // Lock still released.
    expect(calls.lockReleased).toBe(1)
  })

  test('HEAD advanced: re-materializes plugins and notifies exactly once', async () => {
    const { deps, calls } = makeDeps({}, { advanceTo: { acme: 'sha-new' } })
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({
      status: 'updated',
      marketplaces: ['acme'],
      plugins: ['tool@acme'],
    })
    expect(calls.pluginUpdates).toEqual([new Set(['acme'])])
    // Caches dropped before AND after the plugin re-materialization.
    expect(calls.invalidations).toBe(2)
    expect(calls.notified).toHaveLength(1)
    expect(calls.notified[0]).toContain('plugin updated')
    expect(calls.notified[0]).toContain('tool')
    expect(calls.lockAcquired).toBe(1)
    expect(calls.lockReleased).toBe(1)
  })

  test('falls back to marketplace names when no installed plugin changed', async () => {
    const { deps, calls } = makeDeps(
      { updateInstalledPlugins: async () => [] },
      { advanceTo: { acme: 'sha-new' } },
    )
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({
      status: 'updated',
      marketplaces: ['acme'],
      plugins: [],
    })
    expect(calls.notified[0]).toContain('plugin updated: acme')
  })

  test('non-git installLocation is skipped without pulling', async () => {
    const { deps, calls } = makeDeps({ isGitRepo: () => false })
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'up-to-date', checked: 1 })
    expect(calls.pulled).toEqual([])
    expect(calls.notified).toEqual([])
  })

  test('unreadable HEAD never counts as an update', async () => {
    const { deps, calls } = makeDeps({ readHeadSha: async () => null })
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'up-to-date', checked: 1 })
    // rev-parse failed up front, so the network fetch never happened.
    expect(calls.pulled).toEqual([])
    expect(calls.notified).toEqual([])
  })

  test('plugin re-materialization failure still notifies (marketplaces did move)', async () => {
    const { deps, calls } = makeDeps(
      {
        updateInstalledPlugins: async () => {
          throw new Error('installed_plugins.json is locked')
        },
      },
      { advanceTo: { acme: 'sha-new' } },
    )
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({
      status: 'updated',
      marketplaces: ['acme'],
      plugins: [],
    })
    expect(calls.notified).toHaveLength(1)
    expect(calls.lockReleased).toBe(1)
  })
})

describe('runBackgroundPluginUpdateOnce — isolation between marketplaces', () => {
  const three: Target[] = [
    { name: 'alpha', installLocation: '/cache/marketplaces/alpha' },
    { name: 'beta', installLocation: '/cache/marketplaces/beta' },
    { name: 'gamma', installLocation: '/cache/marketplaces/gamma' },
  ]

  test('a failing pull does not stop the others', async () => {
    const { deps, calls } = makeDeps(
      {},
      {
        targets: three,
        failPull: ['beta'],
        advanceTo: { alpha: 'sha-a2', gamma: 'sha-g2' },
      },
    )
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(calls.pulled).toEqual(['alpha', 'beta', 'gamma'])
    expect(outcome).toEqual({
      status: 'updated',
      marketplaces: ['alpha', 'gamma'],
      plugins: ['tool@alpha', 'tool@gamma'],
    })
    // One notification for the whole pass, never one per marketplace.
    expect(calls.notified).toHaveLength(1)
  })

  test('a throwing git dependency is contained to its own marketplace', async () => {
    const { deps, calls } = makeDeps(
      {
        isGitRepo: dir => {
          if (dir.endsWith('beta')) {
            throw new Error('EACCES')
          }
          return true
        },
      },
      { targets: three, advanceTo: { gamma: 'sha-g2' } },
    )
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({
      status: 'updated',
      marketplaces: ['gamma'],
      plugins: ['tool@gamma'],
    })
    expect(calls.lockReleased).toBe(1)
  })

  test('every marketplace failing stays silent', async () => {
    const { deps, calls } = makeDeps(
      {},
      { targets: three, failPull: ['alpha', 'beta', 'gamma'] },
    )
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'up-to-date', checked: 3 })
    expect(calls.notified).toEqual([])
    expect(calls.invalidations).toBe(0)
  })
})

describe('runBackgroundPluginUpdateOnce — cross-process lock', () => {
  test('backs off without fetching when another instance holds the lock', async () => {
    const { deps, calls } = makeDeps({ acquireLock: async () => false })
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'locked' })
    expect(calls.pulled).toEqual([])
    // Never acquired, so it must not be released either.
    expect(calls.lockReleased).toBe(0)
  })

  test('lock is released even when the pass throws', async () => {
    const { deps, calls } = makeDeps(
      {
        invalidateCaches: () => {
          throw new Error('cache teardown exploded')
        },
      },
      { advanceTo: { acme: 'sha-new' } },
    )
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'error' })
    expect(calls.lockReleased).toBe(1)
    expect(calls.notified).toEqual([])
  })

  test('a throwing listing yields error status and never throws out', async () => {
    const { deps, calls } = makeDeps({
      listGitMarketplaces: async () => {
        throw new Error('known_marketplaces.json is corrupt')
      },
    })
    const outcome = await updater.runBackgroundPluginUpdateOnce(deps)

    expect(outcome).toEqual({ status: 'error' })
    expect(calls.lockAcquired).toBe(0)
    expect(calls.notified).toEqual([])
  })
})

describe('maybeScheduleBackgroundPluginUpdate', () => {
  const prodEnv = { NODE_ENV: 'production' } as NodeJS.ProcessEnv

  test('installs one loop and schedules again only after a run finishes', async () => {
    const scheduler = makeScheduler()
    const ignoredScheduler = makeScheduler()
    let runs = 0
    let finishRun!: (outcome: Outcome) => void
    const runResult = new Promise<Outcome>(resolve => {
      finishRun = resolve
    })

    const first = updater.maybeScheduleBackgroundPluginUpdate({
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
    const second = updater.maybeScheduleBackgroundPluginUpdate({
      env: prodEnv,
      run: async () => ({ status: 'error' }),
      scheduleFn: ignoredScheduler.scheduleFn,
    })

    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(ignoredScheduler.tasks).toHaveLength(0)
    expect(scheduler.tasks).toHaveLength(1)
    expect(scheduler.tasks[0]?.delayMs).toBe(3 * 60 * 1000)
    expect(scheduler.tasks[0]?.unrefed).toBe(true)

    const firing = scheduler.tasks[0]!.callback()
    expect(runs).toBe(1)
    expect(scheduler.tasks).toHaveLength(1)

    finishRun({
      status: 'updated',
      marketplaces: ['acme'],
      plugins: ['tool@acme'],
    })
    await firing
    expect(scheduler.tasks).toHaveLength(2)
    expect(scheduler.tasks[1]?.delayMs).toBe(120_000)
    expect(scheduler.tasks[1]?.unrefed).toBe(true)
  })

  test('aborting the controller cancels the sweep and stops the loop', async () => {
    const controller = new AbortController()
    const scheduler = makeScheduler()
    const seenSignals: AbortSignal[] = []
    updater.maybeScheduleBackgroundPluginUpdate({
      env: prodEnv,
      abortController: controller,
      run: async signal => {
        seenSignals.push(signal)
        return { status: 'up-to-date', checked: 1 }
      },
      scheduleFn: scheduler.scheduleFn,
    })

    await scheduler.tasks[0]!.callback()
    expect(seenSignals[0]).toBe(controller.signal)

    controller.abort()
    await scheduler.tasks[1]!.callback()
    expect(seenSignals).toHaveLength(1)
    expect(scheduler.tasks).toHaveLength(2)
  })

  test('an aborted signal stops the sweep between marketplaces', async () => {
    // A git fetch against an unreachable remote burns the 30s timeout per
    // marketplace; once shutdown starts, the queue behind the cancelled child
    // must not start another one.
    const controller = new AbortController()
    const pulled: string[] = []
    const { deps } = makeDeps(
      {
        pull: async target => {
          pulled.push(target.name)
          controller.abort()
          return { ok: true, detail: '' }
        },
      },
      {
        targets: [
          { name: 'one', installLocation: '/cache/one' },
          { name: 'two', installLocation: '/cache/two' },
        ],
      },
    )

    await updater.runBackgroundPluginUpdateOnce(deps, controller.signal)

    expect(pulled).toEqual(['one'])
  })

  test('stops the loop after a permanent skipped outcome', async () => {
    const scheduler = makeScheduler()
    updater.maybeScheduleBackgroundPluginUpdate({
      env: prodEnv,
      run: async () => ({
        status: 'skipped',
        reason: 'NODE_ENV=test',
        permanent: true,
      }),
      scheduleFn: scheduler.scheduleFn,
    })

    await scheduler.tasks[0]!.callback()
    expect(scheduler.tasks).toHaveLength(1)
  })

  test('keeps looping after a reversible skip so re-enabling takes effect live', async () => {
    const scheduler = makeScheduler()
    updater.maybeScheduleBackgroundPluginUpdate({
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
    expect(scheduler.tasks[1]?.delayMs).toBe(1_800_000)
  })

  test.each([
    { status: 'locked' } as Outcome,
    { status: 'throttled' } as Outcome,
    { status: 'error' } as Outcome,
  ])('continues the loop after $status', async outcome => {
    const scheduler = makeScheduler()
    updater.maybeScheduleBackgroundPluginUpdate({
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
      updater.maybeScheduleBackgroundPluginUpdate({
        env: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
        run: async () => ({ status: 'error' }),
        scheduleFn: scheduler.scheduleFn,
      }),
    ).toBe(false)

    expect(
      updater.maybeScheduleBackgroundPluginUpdate({
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
      updater.maybeScheduleBackgroundPluginUpdate({
        env: prodEnv,
        run: async () => ({ status: 'up-to-date', checked: 1 }),
        scheduleFn: scheduler.scheduleFn,
      }),
    ).toBe(true)
    expect(scheduler.tasks).toHaveLength(1)
  })

  test('a rejecting run is swallowed (logged, not unhandled)', async () => {
    const scheduler = makeScheduler()
    updater.maybeScheduleBackgroundPluginUpdate({
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

describe('pluginUpdateNotifier', () => {
  test('delivers directly when a notifier is registered', () => {
    const received: string[] = []
    notifierMod.setPluginUpdateNotifier(text => received.push(text))
    notifierMod.emitPluginUpdateNotification('hello')
    expect(received).toEqual(['hello'])
  })

  test('buffers when no notifier is registered and flushes once on registration', () => {
    notifierMod.emitPluginUpdateNotification('buffered')

    const received: string[] = []
    notifierMod.setPluginUpdateNotifier(text => received.push(text))
    expect(received).toEqual(['buffered'])

    // Re-registering (e.g. component remount) must not replay the notice.
    const later: string[] = []
    notifierMod.setPluginUpdateNotifier(text => later.push(text))
    expect(later).toEqual([])
  })

  test('unregistering (null) returns to buffering mode', () => {
    const received: string[] = []
    notifierMod.setPluginUpdateNotifier(text => received.push(text))
    notifierMod.setPluginUpdateNotifier(null)

    notifierMod.emitPluginUpdateNotification('while unmounted')
    expect(received).toEqual([])

    notifierMod.setPluginUpdateNotifier(text => received.push(text))
    expect(received).toEqual(['while unmounted'])
  })

  test('the two update channels are independent registries', async () => {
    const occNotifier = await import('../updateNotifier.js')
    const plugin: string[] = []
    const occ: string[] = []
    notifierMod.setPluginUpdateNotifier(t => plugin.push(t))
    occNotifier.setBackgroundUpdateNotifier(t => occ.push(t))

    notifierMod.emitPluginUpdateNotification('plugin updated: acme')
    expect(plugin).toEqual(['plugin updated: acme'])
    expect(occ).toEqual([])

    occNotifier.resetBackgroundUpdateNotifierForTests()
  })
})
