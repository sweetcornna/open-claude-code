/**
 * Tests for the deferred self-install (deferredOccInstall.ts).
 *
 * The whole point of this module is a negative: nothing may install while the
 * session is alive, because `npm|bun install -g` deletes the content-hashed
 * chunks the running process still imports lazily. These tests pin the two
 * guards that decide whether the queued install is allowed to spawn at all.
 *
 * Only the log/debug leaves are mock.module'd (shared mocks, per CLAUDE.md);
 * the spawn and the live-session probe come in through injected deps, so
 * nothing here spawns a real package manager.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let deferred: typeof import('../deferredOccInstall.js')
let cleanupRegistry: typeof import('src/utils/process/cleanupRegistry.js')

beforeAll(async () => {
  deferred = await import('../deferredOccInstall.js')
  cleanupRegistry = await import('src/utils/process/cleanupRegistry.js')
})

afterEach(() => {
  deferred.resetDeferredOccInstallForTests()
})

type Install = import('../deferredOccInstall.js').DeferredOccInstall

function makeInstall(overrides: Partial<Install> = {}): Install {
  return {
    pkgManager: 'npm',
    spec: '@scope/pkg@latest',
    version: '1.1.0',
    ...overrides,
  }
}

function makeDeps(
  overrides: Partial<
    import('../deferredOccInstall.js').DeferredOccInstallDeps
  > = {},
): {
  deps: import('../deferredOccInstall.js').DeferredOccInstallDeps
  spawned: Install[]
} {
  const spawned: Install[] = []
  return {
    spawned,
    deps: {
      hasOtherLiveSessions: async () => false,
      spawnInstaller: install => {
        spawned.push(install)
      },
      ...overrides,
    },
  }
}

describe('flushDeferredOccInstall', () => {
  test('does nothing when nothing was queued', async () => {
    const { deps, spawned } = makeDeps()
    await deferred.flushDeferredOccInstall(deps)
    expect(spawned).toEqual([])
  })

  test('spawns the queued install when this is the last session', async () => {
    const install = makeInstall()
    deferred.armDeferredOccInstall(install)
    expect(deferred.getPendingDeferredOccInstall()).toEqual(install)

    const { deps, spawned } = makeDeps()
    await deferred.flushDeferredOccInstall(deps)

    expect(spawned).toEqual([install])
    // Consumed: a second flush must not spawn a duplicate installer.
    expect(deferred.getPendingDeferredOccInstall()).toBeUndefined()
    await deferred.flushDeferredOccInstall(deps)
    expect(spawned).toHaveLength(1)
  })

  test('postpones while another session still runs from the same tree', async () => {
    // Installing here would strand that session's remaining lazy imports —
    // exactly the wedge this whole mechanism exists to prevent.
    deferred.armDeferredOccInstall(makeInstall())
    const { deps, spawned } = makeDeps({
      hasOtherLiveSessions: async () => true,
    })

    await deferred.flushDeferredOccInstall(deps)

    expect(spawned).toEqual([])
  })

  test('postpones when the update lock is already held', async () => {
    deferred.armDeferredOccInstall(
      makeInstall({ acquireLock: async () => false }),
    )
    const { deps, spawned } = makeDeps()

    await deferred.flushDeferredOccInstall(deps)

    expect(spawned).toEqual([])
  })

  test('spawns once the lock is acquired', async () => {
    let lockCalls = 0
    deferred.armDeferredOccInstall(
      makeInstall({
        acquireLock: async () => {
          lockCalls++
          return true
        },
      }),
    )
    const { deps, spawned } = makeDeps()

    await deferred.flushDeferredOccInstall(deps)

    expect(lockCalls).toBe(1)
    expect(spawned).toHaveLength(1)
  })

  test('a newer arm replaces the queued version', async () => {
    deferred.armDeferredOccInstall(makeInstall({ version: '1.1.0' }))
    deferred.armDeferredOccInstall(makeInstall({ version: '1.2.0' }))
    const { deps, spawned } = makeDeps()

    await deferred.flushDeferredOccInstall(deps)

    expect(spawned.map(s => s.version)).toEqual(['1.2.0'])
  })

  test('a throwing probe is swallowed and drops the install', async () => {
    deferred.armDeferredOccInstall(makeInstall())
    const { deps, spawned } = makeDeps({
      hasOtherLiveSessions: async () => {
        throw new Error('readdir failed')
      },
    })

    await deferred.flushDeferredOccInstall(deps)

    expect(spawned).toEqual([])
  })
})

describe('arming registers with the shutdown cleanup registry', () => {
  test('running cleanup functions flushes the queued install', async () => {
    // Production wiring: gracefulShutdown → runCleanupFunctions → flush. The
    // registry calls the flush with no arguments, so this run uses the real
    // deps — a held lock keeps it from reaching an actual spawn while still
    // proving the queue was consumed.
    const previousConfigDir = process.env.OCC_CONFIG_DIR
    process.env.OCC_CONFIG_DIR = mkdtempSync(
      join(tmpdir(), 'occ-deferred-install-'),
    )
    try {
      deferred.armDeferredOccInstall(
        makeInstall({ acquireLock: async () => false }),
      )
      expect(deferred.getPendingDeferredOccInstall()).toBeDefined()

      await cleanupRegistry.runCleanupFunctions()

      expect(deferred.getPendingDeferredOccInstall()).toBeUndefined()
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.OCC_CONFIG_DIR
      } else {
        process.env.OCC_CONFIG_DIR = previousConfigDir
      }
    }
  })
})
