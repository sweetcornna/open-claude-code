/**
 * Tests for persisted deferred self-install coordination.
 *
 * Only the log/debug leaves are mock.module'd (shared mocks, per CLAUDE.md);
 * filesystem state lives under a temporary OCC_CONFIG_DIR and every external
 * action is injected.
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
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let deferred: typeof import('../deferredOccInstall.js')
let configDir: string
const previousConfigDir = process.env.OCC_CONFIG_DIR

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'occ-deferred-install-'))
  process.env.OCC_CONFIG_DIR = configDir
  deferred = await import('../deferredOccInstall.js')
})

afterEach(() => {
  deferred.resetDeferredOccInstallForTests()
  rmSync(join(configDir, 'pending-updates'), { recursive: true, force: true })
})

afterAll(() => {
  if (previousConfigDir === undefined) {
    delete process.env.OCC_CONFIG_DIR
  } else {
    process.env.OCC_CONFIG_DIR = previousConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
})

type Install = import('../deferredOccInstall.js').DeferredOccInstall
type Deps = import('../deferredOccInstall.js').DeferredOccInstallDeps

function makeInstall(overrides: Partial<Install> = {}): Install {
  return {
    pkgManager: 'npm',
    spec: '@scope/pkg@latest',
    version: '1.1.0',
    ...overrides,
  }
}

function makeDeps(overrides: Partial<Deps> = {}): {
  deps: Deps
  spawned: Install[]
} {
  const spawned: Install[] = []
  return {
    spawned,
    deps: {
      hasOtherLiveSessions: async () => false,
      acquireLock: async () => true,
      releaseLock: async () => {},
      packageSpec: () => '@scope/pkg@latest',
      spawnInstaller: async install => {
        spawned.push(install)
      },
      // The gates default to "an ordinary enabled session". The suite runs
      // under NODE_ENV=test, which is itself a gate, so the default env has to
      // be an explicit object rather than process.env.
      env: {},
      getAutoUpdatesConfig: () => undefined,
      getEssentialTrafficOnlyReason: () => null,
      ...overrides,
    },
  }
}

function candidateCount(): number {
  try {
    return readdirSync(join(configDir, 'pending-updates')).filter(name =>
      name.endsWith('.json'),
    ).length
  } catch {
    return 0
  }
}

describe('flushDeferredOccInstall', () => {
  test('does nothing when nothing was queued', async () => {
    const { deps, spawned } = makeDeps()
    await deferred.flushDeferredOccInstall(deps)
    expect(spawned).toEqual([])
  })

  test('persists a candidate that another session can install', async () => {
    const install = makeInstall()
    await deferred.armDeferredOccInstall(install)
    expect(deferred.getPendingDeferredOccInstall()).toEqual(install)
    expect(candidateCount()).toBe(1)

    deferred.resetDeferredOccInstallForTests()
    const { deps, spawned } = makeDeps()
    await deferred.flushDeferredOccInstall(deps)

    expect(spawned).toEqual([install])
    expect(candidateCount()).toBe(0)
    await deferred.flushDeferredOccInstall(deps)
    expect(spawned).toHaveLength(1)
  })

  test('keeps the candidate while another session uses the install tree', async () => {
    await deferred.armDeferredOccInstall(makeInstall())
    const blocked = makeDeps({
      hasOtherLiveSessions: async () => true,
    })

    await deferred.flushDeferredOccInstall(blocked.deps)

    expect(blocked.spawned).toEqual([])
    expect(candidateCount()).toBe(1)

    deferred.resetDeferredOccInstallForTests()
    const successor = makeDeps()
    await deferred.flushDeferredOccInstall(successor.deps)
    expect(successor.spawned.map(install => install.version)).toEqual(['1.1.0'])
    expect(candidateCount()).toBe(0)
  })

  test('keeps the candidate when the update lock is held', async () => {
    await deferred.armDeferredOccInstall(makeInstall())
    const blocked = makeDeps({ acquireLock: async () => false })

    await deferred.flushDeferredOccInstall(blocked.deps)

    expect(blocked.spawned).toEqual([])
    expect(candidateCount()).toBe(1)

    const successor = makeDeps()
    await deferred.flushDeferredOccInstall(successor.deps)
    expect(successor.spawned).toHaveLength(1)
    expect(candidateCount()).toBe(0)
  })

  test('installs only the newest candidate and consumes all older candidates', async () => {
    await deferred.armDeferredOccInstall(makeInstall({ version: '1.1.0' }))
    await deferred.armDeferredOccInstall(makeInstall({ version: '1.2.0' }))
    const { deps, spawned } = makeDeps()

    await deferred.flushDeferredOccInstall(deps)

    expect(spawned.map(install => install.version)).toEqual(['1.2.0'])
    expect(candidateCount()).toBe(0)
  })

  test('reconstructs the trusted package spec instead of persisting commands', async () => {
    await deferred.armDeferredOccInstall(
      makeInstall({ spec: '@attacker/pkg@latest' }),
    )
    const { deps, spawned } = makeDeps({
      packageSpec: () => '@sweetcornna/open-claude-code@latest',
    })

    await deferred.flushDeferredOccInstall(deps)

    expect(spawned[0]?.spec).toBe('@sweetcornna/open-claude-code@latest')
  })

  test('keeps the candidate when the live-session probe fails', async () => {
    await deferred.armDeferredOccInstall(makeInstall())
    const { deps, spawned } = makeDeps({
      hasOtherLiveSessions: async () => {
        throw new Error('readdir failed')
      },
    })

    await deferred.flushDeferredOccInstall(deps)

    expect(spawned).toEqual([])
    expect(candidateCount()).toBe(1)
  })

  test('never spawns from a dev or test process, and keeps the candidate', async () => {
    // A `bun run dev` checkout has no standing to install, but also none to
    // cancel an update a real session queued.
    for (const nodeEnv of ['test', 'development']) {
      await deferred.armDeferredOccInstall(makeInstall())
      const { deps, spawned } = makeDeps({ env: { NODE_ENV: nodeEnv } })

      await deferred.flushDeferredOccInstall(deps)

      expect(spawned).toEqual([])
      expect(candidateCount()).toBe(1)
      deferred.resetDeferredOccInstallForTests()
      rmSync(join(configDir, 'pending-updates'), {
        recursive: true,
        force: true,
      })
    }
  })

  test('discards the candidate when the user has turned auto-updates off', async () => {
    // The arm-side session may be long gone; the switch has to be re-read here
    // or `DISABLE_AUTOUPDATER=1 occ` still installs what an earlier one queued.
    // Discarding avoids re-deciding this on every exit.
    for (const overrides of [
      { env: { DISABLE_AUTOUPDATER: '1' } },
      { getAutoUpdatesConfig: () => false },
      {
        getEssentialTrafficOnlyReason: () =>
          'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      },
    ] satisfies Partial<Deps>[]) {
      await deferred.armDeferredOccInstall(makeInstall())
      const { deps, spawned } = makeDeps(overrides)

      await deferred.flushDeferredOccInstall(deps)

      expect(spawned).toEqual([])
      expect(candidateCount()).toBe(0)
      deferred.resetDeferredOccInstallForTests()
    }
  })

  test('an explicit autoUpdates:true is not mistaken for disabled', async () => {
    await deferred.armDeferredOccInstall(makeInstall())
    const { deps, spawned } = makeDeps({ getAutoUpdatesConfig: () => true })

    await deferred.flushDeferredOccInstall(deps)

    expect(spawned).toHaveLength(1)
  })

  test('keeps the candidate and releases the lock on async spawn failure', async () => {
    await deferred.armDeferredOccInstall(makeInstall())
    let releases = 0
    const { deps } = makeDeps({
      releaseLock: async () => {
        releases++
      },
      spawnInstaller: () =>
        new Promise((_, reject) => {
          queueMicrotask(() => {
            reject(Object.assign(new Error('spawn failed'), { code: 'ENOENT' }))
          })
        }),
    })

    await deferred.flushDeferredOccInstall(deps)

    expect(candidateCount()).toBe(1)
    expect(releases).toBe(1)
  })
})
