/**
 * Tests for registry selection on the self-update path (updateRegistry.ts).
 *
 * Everything with a side effect — the tarball probe, `npm config get
 * registry`, the bunfig read, and the metadata fetches behind the integrity
 * gate — is injected, so nothing here mocks a module and nothing here touches
 * the network. Only the telemetry leaves are mock.module'd, per CLAUDE.md.
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let registryMod: typeof import('../updateRegistry.js')
let packageManagerMod: typeof import('src/utils/process/packageManager.js')

beforeAll(async () => {
  registryMod = await import('../updateRegistry.js')
  packageManagerMod = await import('src/utils/process/packageManager.js')
})

afterEach(() => {
  registryMod.resetUpdateRegistryCacheForTests()
})

const PKG = '@sweetcornna/open-claude-code'
const OFFICIAL = 'https://registry.npmjs.org'
const MIRROR = 'https://registry.npmmirror.com'
const YARN = 'https://registry.yarnpkg.com'

/** No npmrc, no bunfig, no env — the state that should lead to a race. */
function unconfigured(): {
  env: NodeJS.ProcessEnv
  getNpmConfigRegistry: () => Promise<string | null>
  getBunfigRegistry: () => string | null
} {
  return {
    env: {} as NodeJS.ProcessEnv,
    getNpmConfigRegistry: async () => `${OFFICIAL}/`,
    getBunfigRegistry: () => null,
  }
}

/**
 * A probe whose completion time is dictated per registry, so a test can say
 * "this one is 40 ms and that one is 4 s" without waiting for either.
 */
function timedProbe(delaysMs: Record<string, number>) {
  const attempted: string[] = []
  const probe: import('../updateRegistry.js').RegistryProbe = (
    registry,
    _packageName,
    _version,
    signal,
  ) => {
    attempted.push(registry)
    const delay = delaysMs[registry]
    return new Promise<void>((resolve, reject) => {
      if (delay === undefined) {
        reject(new Error(`${registry}: HTTP 404`))
        return
      }
      const timer = setTimeout(resolve, delay)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      })
    })
  }
  return { probe, attempted }
}

describe('raceRegistries', () => {
  test('the fastest candidate wins', async () => {
    // The whole point: 17,599 B/s against 1,101,809 B/s for the same tarball,
    // measured at the same moment. Whoever delivers the probe first gets both
    // the version check and the install.
    const { probe, attempted } = timedProbe({
      [OFFICIAL]: 400,
      [YARN]: 300,
      [MIRROR]: 5,
    })
    const winner = await registryMod.raceRegistries(
      [OFFICIAL, YARN, MIRROR],
      PKG,
      '2.38.1',
      { probe, timeoutMs: 2_000 },
    )

    expect(winner).toBe(MIRROR)
    // Concurrent, not sequential: measuring a slow registry first would cost
    // the full timeout before the fast one was even tried.
    expect(attempted.sort()).toEqual([MIRROR, OFFICIAL, YARN].sort())
  })

  test('the official registry can win, and does when it is fastest', async () => {
    const { probe } = timedProbe({ [OFFICIAL]: 5, [MIRROR]: 400 })
    expect(
      await registryMod.raceRegistries([OFFICIAL, MIRROR], PKG, '2.38.1', {
        probe,
        timeoutMs: 2_000,
      }),
    ).toBe(OFFICIAL)
  })

  test('losers are aborted the moment a winner appears', async () => {
    // Racing full downloads would burn the bandwidth this exists to save; the
    // losing probes must stop pulling bytes immediately.
    const aborted: string[] = []
    const probe: import('../updateRegistry.js').RegistryProbe = (
      registry,
      _pkg,
      _version,
      signal,
    ) =>
      new Promise<void>((resolve, reject) => {
        if (registry === MIRROR) {
          resolve()
          return
        }
        signal.addEventListener('abort', () => {
          aborted.push(registry)
          reject(new Error('aborted'))
        })
      })

    expect(
      await registryMod.raceRegistries(
        [OFFICIAL, YARN, MIRROR],
        PKG,
        '2.38.1',
        {
          probe,
          timeoutMs: 2_000,
        },
      ),
    ).toBe(MIRROR)
    expect(aborted.sort()).toEqual([OFFICIAL, YARN].sort())
  })

  test('returns null when every probe fails', async () => {
    const { probe } = timedProbe({})
    expect(
      await registryMod.raceRegistries([OFFICIAL, MIRROR], PKG, '2.38.1', {
        probe,
        timeoutMs: 2_000,
      }),
    ).toBeNull()
  })

  test('returns null when nobody answers before the timeout', async () => {
    const { probe } = timedProbe({ [OFFICIAL]: 10_000, [MIRROR]: 10_000 })
    expect(
      await registryMod.raceRegistries([OFFICIAL, MIRROR], PKG, '2.38.1', {
        probe,
        timeoutMs: 20,
      }),
    ).toBeNull()
  })
})

describe('resolveUpdateRegistry', () => {
  test('races when nothing is configured and reports the winner as raced', async () => {
    const { probe } = timedProbe({ [OFFICIAL]: 400, [MIRROR]: 5 })
    expect(
      await registryMod.resolveUpdateRegistry({
        ...unconfigured(),
        probeVersion: '2.38.1',
        candidates: [OFFICIAL, MIRROR],
        probe,
        probeTimeoutMs: 2_000,
      }),
    ).toEqual({ registry: MIRROR, source: 'raced' })
  })

  test('an explicitly configured registry is used without probing at all', async () => {
    // They chose it — possibly a private mirror that is the only host carrying
    // the package. Racing it against public registries could only make things
    // worse, so no probe may even be attempted.
    const { probe, attempted } = timedProbe({ [MIRROR]: 1 })
    const choice = await registryMod.resolveUpdateRegistry({
      ...unconfigured(),
      getNpmConfigRegistry: async () => 'https://npm.corp.internal/repo/',
      probeVersion: '2.38.1',
      candidates: [OFFICIAL, MIRROR],
      probe,
      probeTimeoutMs: 2_000,
    })

    expect(choice).toEqual({
      // Trailing slash normalised away; npm reports the slash form.
      registry: 'https://npm.corp.internal/repo',
      source: 'configured',
    })
    expect(attempted).toEqual([])
  })

  test.each([
    ['npm_config_registry', 'npm_config_registry'],
    ['NPM_CONFIG_REGISTRY', 'NPM_CONFIG_REGISTRY'],
  ])('%s is honoured without spawning npm config', async (_label, key) => {
    const { probe, attempted } = timedProbe({ [MIRROR]: 1 })
    let npmConfigSpawns = 0
    const choice = await registryMod.resolveUpdateRegistry({
      ...unconfigured(),
      env: { [key]: 'https://npm.corp.internal/' } as NodeJS.ProcessEnv,
      getNpmConfigRegistry: async () => {
        npmConfigSpawns++
        return `${OFFICIAL}/`
      },
      probeVersion: '2.38.1',
      candidates: [OFFICIAL, MIRROR],
      probe,
      probeTimeoutMs: 2_000,
    })

    expect(choice).toEqual({
      registry: 'https://npm.corp.internal',
      source: 'configured',
    })
    expect(npmConfigSpawns).toBe(0)
    expect(attempted).toEqual([])
  })

  test('a bunfig registry counts as configured', async () => {
    // `npm config get registry` cannot see bunfig.toml, so a bun user who set
    // one there would otherwise be raced past their own choice.
    const { probe, attempted } = timedProbe({ [MIRROR]: 1 })
    const choice = await registryMod.resolveUpdateRegistry({
      ...unconfigured(),
      getBunfigRegistry: () => 'https://npm.corp.internal',
      probeVersion: '2.38.1',
      candidates: [OFFICIAL, MIRROR],
      probe,
      probeTimeoutMs: 2_000,
    })

    expect(choice).toEqual({
      registry: 'https://npm.corp.internal',
      source: 'configured',
    })
    expect(attempted).toEqual([])
  })

  test('a configured registry that is just the default does not suppress the race', async () => {
    const { probe } = timedProbe({ [MIRROR]: 1 })
    expect(
      await registryMod.resolveUpdateRegistry({
        ...unconfigured(),
        getNpmConfigRegistry: async () => `${OFFICIAL}/`,
        probeVersion: '2.38.1',
        candidates: [OFFICIAL, MIRROR],
        probe,
        probeTimeoutMs: 2_000,
      }),
    ).toEqual({ registry: MIRROR, source: 'raced' })
  })

  test('every probe failing falls back to the official registry', async () => {
    const { probe } = timedProbe({})
    expect(
      await registryMod.resolveUpdateRegistry({
        ...unconfigured(),
        probeVersion: '2.38.1',
        candidates: [OFFICIAL, MIRROR, YARN],
        probe,
        probeTimeoutMs: 2_000,
      }),
    ).toEqual({ registry: OFFICIAL, source: 'official' })
  })

  test('the official registry winning is reported as official, not raced', async () => {
    // Which matters: `raced` is what triggers the integrity gate, and there is
    // nothing to cross-check the official registry against but itself.
    const { probe } = timedProbe({ [OFFICIAL]: 1, [MIRROR]: 400 })
    expect(
      await registryMod.resolveUpdateRegistry({
        ...unconfigured(),
        probeVersion: '2.38.1',
        candidates: [OFFICIAL, MIRROR],
        probe,
        probeTimeoutMs: 2_000,
      }),
    ).toEqual({ registry: OFFICIAL, source: 'official' })
  })

  test(`${'OCC_UPDATE_REGISTRY'}=official pins npmjs and skips racing`, async () => {
    const { probe, attempted } = timedProbe({ [MIRROR]: 1 })
    expect(
      await registryMod.resolveUpdateRegistry({
        ...unconfigured(),
        env: { OCC_UPDATE_REGISTRY: 'official' } as NodeJS.ProcessEnv,
        probeVersion: '2.38.1',
        candidates: [OFFICIAL, MIRROR],
        probe,
        probeTimeoutMs: 2_000,
      }),
    ).toEqual({ registry: OFFICIAL, source: 'pinned' })
    expect(attempted).toEqual([])
  })

  test('OCC_UPDATE_REGISTRY also accepts an explicit URL', async () => {
    const { probe, attempted } = timedProbe({ [MIRROR]: 1 })
    expect(
      await registryMod.resolveUpdateRegistry({
        ...unconfigured(),
        env: { OCC_UPDATE_REGISTRY: `${YARN}/` } as NodeJS.ProcessEnv,
        probeVersion: '2.38.1',
        candidates: [OFFICIAL, MIRROR],
        probe,
        probeTimeoutMs: 2_000,
      }),
    ).toEqual({ registry: YARN, source: 'pinned' })
    expect(attempted).toEqual([])
  })

  test('an unusable OCC_UPDATE_REGISTRY is ignored rather than obeyed', async () => {
    const { probe } = timedProbe({ [MIRROR]: 1 })
    expect(
      await registryMod.resolveUpdateRegistry({
        ...unconfigured(),
        env: {
          OCC_UPDATE_REGISTRY: 'https://evil.example/&calc',
        } as NodeJS.ProcessEnv,
        probeVersion: '2.38.1',
        candidates: [OFFICIAL, MIRROR],
        probe,
        probeTimeoutMs: 2_000,
      }),
    ).toEqual({ registry: MIRROR, source: 'raced' })
  })
})

describe('getSessionUpdateRegistry', () => {
  test('probes once per process, not once per 30-minute pass', async () => {
    let races = 0
    const probe: import('../updateRegistry.js').RegistryProbe =
      async registry => {
        if (registry === MIRROR) {
          races++
          return
        }
        throw new Error('slow')
      }
    const options = {
      ...unconfigured(),
      probeVersion: '2.38.1',
      candidates: [OFFICIAL, MIRROR],
      probe,
      probeTimeoutMs: 2_000,
    }

    expect(await registryMod.getSessionUpdateRegistry(options)).toEqual({
      registry: MIRROR,
      source: 'raced',
    })
    expect(await registryMod.getSessionUpdateRegistry(options)).toEqual({
      registry: MIRROR,
      source: 'raced',
    })
    expect(races).toBe(1)
  })
})

describe('approveRegistryForInstall', () => {
  const OFFICIAL_DIST = {
    version: '2.38.1',
    integrity: 'sha512-lRENOWUFnBSRv7vHYdUsUnp1qpBhC9Q/m6Jhhm1MHA14IGc=',
    shasum: '00184e3eaeae3cff4b739f6feb11d8e12bfa8922',
  }

  function distFetcher(
    byRegistry: Record<
      string,
      {
        version: string
        integrity: string | null
        shasum: string | null
      } | null
    >,
  ) {
    const asked: string[] = []
    const fetchDist: import('../updateRegistry.js').FetchVersionDist =
      async registry => {
        asked.push(registry)
        return byRegistry[registry] ?? null
      }
    return { fetchDist, asked }
  }

  test('a mirror advertising the official integrity is allowed to install', async () => {
    const { fetchDist, asked } = distFetcher({
      [OFFICIAL]: OFFICIAL_DIST,
      [MIRROR]: OFFICIAL_DIST,
    })
    expect(
      await registryMod.approveRegistryForInstall({
        choice: { registry: MIRROR, source: 'raced' },
        version: '2.38.1',
        packageName: PKG,
        fetchDist,
      }),
    ).toBe(MIRROR)
    // The expected value must come from the official registry, never from the
    // mirror being checked.
    expect(asked).toContain(OFFICIAL)
  })

  test('an integrity mismatch blocks the mirror install', async () => {
    // The case the gate exists for: a mirror serving something that is not
    // what npm published. It must not be allowed to become the running occ.
    const { fetchDist } = distFetcher({
      [OFFICIAL]: OFFICIAL_DIST,
      [MIRROR]: { ...OFFICIAL_DIST, integrity: 'sha512-tampered' },
    })
    expect(
      await registryMod.approveRegistryForInstall({
        choice: { registry: MIRROR, source: 'raced' },
        version: '2.38.1',
        packageName: PKG,
        fetchDist,
      }),
    ).toBe(OFFICIAL)
  })

  test('a mirror that does not carry the version is rejected', async () => {
    const { fetchDist } = distFetcher({
      [OFFICIAL]: OFFICIAL_DIST,
      [MIRROR]: null,
    })
    expect(
      await registryMod.approveRegistryForInstall({
        choice: { registry: MIRROR, source: 'raced' },
        version: '2.38.1',
        packageName: PKG,
        fetchDist,
      }),
    ).toBe(OFFICIAL)
  })

  test('no official integrity means no mirror install', async () => {
    // Unverifiable is treated as failed. The user still gets the update, just
    // from the canonical source.
    const { fetchDist } = distFetcher({
      [OFFICIAL]: null,
      [MIRROR]: OFFICIAL_DIST,
    })
    expect(
      await registryMod.approveRegistryForInstall({
        choice: { registry: MIRROR, source: 'raced' },
        version: '2.38.1',
        packageName: PKG,
        fetchDist,
      }),
    ).toBe(OFFICIAL)
  })

  test('a throwing metadata fetch falls back instead of propagating', async () => {
    expect(
      await registryMod.approveRegistryForInstall({
        choice: { registry: MIRROR, source: 'raced' },
        version: '2.38.1',
        packageName: PKG,
        fetchDist: async () => {
          throw new Error('network down')
        },
      }),
    ).toBe(OFFICIAL)
  })

  test('falls back to shasum when the official document predates integrity', async () => {
    const legacy = { version: '2.38.1', integrity: null, shasum: 'abc123' }
    const { fetchDist } = distFetcher({ [OFFICIAL]: legacy, [MIRROR]: legacy })
    expect(
      await registryMod.approveRegistryForInstall({
        choice: { registry: MIRROR, source: 'raced' },
        version: '2.38.1',
        packageName: PKG,
        fetchDist,
      }),
    ).toBe(MIRROR)
  })

  test('neither hash available is a rejection, not a pass', async () => {
    const nothing = { version: '2.38.1', integrity: null, shasum: null }
    const { fetchDist } = distFetcher({
      [OFFICIAL]: nothing,
      [MIRROR]: nothing,
    })
    expect(
      await registryMod.approveRegistryForInstall({
        choice: { registry: MIRROR, source: 'raced' },
        version: '2.38.1',
        packageName: PKG,
        fetchDist,
      }),
    ).toBe(OFFICIAL)
  })

  test.each([
    ['configured', 'https://npm.corp.internal'],
    ['pinned', YARN],
    ['official', OFFICIAL],
  ] as const)('a %s registry is used as-is, with no cross-check against npmjs', async (source, registry) => {
    // A registry the user configured is their trust anchor and may
    // legitimately host a build that is not on npmjs at all; holding it to
    // the public hash would break exactly the users the "never race an
    // explicit choice" rule protects.
    let fetches = 0
    expect(
      await registryMod.approveRegistryForInstall({
        choice: { registry, source },
        version: '2.38.1',
        packageName: PKG,
        fetchDist: async () => {
          fetches++
          return null
        },
      }),
    ).toBe(registry)
    expect(fetches).toBe(0)
  })
})

describe('registryCliArgs', () => {
  test('formats one --registry flag for the chosen registry', () => {
    expect(registryMod.registryCliArgs(MIRROR)).toEqual([
      `--registry=${MIRROR}`,
    ])
  })

  test('adds nothing when no registry was chosen', () => {
    expect(registryMod.registryCliArgs(undefined)).toEqual([])
  })

  test('refuses a registry that could not survive a Windows cmd.exe spawn', () => {
    // npm and bun are .cmd shims on Windows, so the spawn goes through a
    // shell; a registry read from npmrc/bunfig/env is not occ's to trust.
    expect(registryMod.registryCliArgs('https://evil.example/&calc')).toEqual(
      [],
    )
  })
})

describe('isSafeRegistryUrl', () => {
  test.each([
    'https://registry.npmjs.org',
    'https://registry.npmmirror.com',
    'http://npm.corp.internal:4873/repo/npm',
    'https://user:token@npm.corp.internal/repo',
  ])('accepts %s', url => {
    expect(packageManagerMod.isSafeRegistryUrl(url)).toBe(true)
  })

  test.each([
    'https://evil.example/&calc',
    'https://evil.example/;rm -rf /',
    'https://evil.example/`id`',
    'https://evil.example/$(id)',
    'https://evil.example/a|b',
    'https://evil.example/a b',
    'https://evil.example/"quoted"',
    'file:///etc/passwd',
    'not a url',
    '',
  ])('rejects %p', url => {
    expect(packageManagerMod.isSafeRegistryUrl(url)).toBe(false)
  })
})

describe('candidate list', () => {
  test('is small, https-only, and keeps the official registry as fallback', () => {
    expect(registryMod.UPDATE_REGISTRY_CANDIDATES).toContain(
      registryMod.OFFICIAL_NPM_REGISTRY,
    )
    expect(registryMod.UPDATE_REGISTRY_CANDIDATES.length).toBeLessThanOrEqual(5)
    for (const candidate of registryMod.UPDATE_REGISTRY_CANDIDATES) {
      expect(candidate).toStartWith('https://')
      expect(packageManagerMod.isSafeRegistryUrl(candidate)).toBe(true)
      expect(registryMod.normalizeRegistryUrl(candidate)).toBe(candidate)
    }
  })

  test('does not rest on a single region-specific mirror', () => {
    const alternatives = registryMod.UPDATE_REGISTRY_CANDIDATES.filter(
      candidate => candidate !== registryMod.OFFICIAL_NPM_REGISTRY,
    )
    expect(alternatives.length).toBeGreaterThan(1)
  })
})
