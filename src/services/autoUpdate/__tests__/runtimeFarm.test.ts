/**
 * Tests for the runtime hard-link farm (runtimeFarm.ts).
 *
 * Everything runs against a temp OCC_CONFIG_DIR — `occConfigDir` is memoized
 * on the env var, so pointing it at a scratch directory is enough to keep the
 * user's real ~/.occ untouched. The module imports nothing but node builtins
 * and src/config/paths.ts, so nothing here is mocked.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let farm: typeof import('../runtimeFarm.js')
let configDir: string
let scratch: string
const previousConfigDir = process.env.OCC_CONFIG_DIR

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'occ-runtime-farm-cfg-'))
  scratch = mkdtempSync(join(tmpdir(), 'occ-runtime-farm-pkg-'))
  process.env.OCC_CONFIG_DIR = configDir
  farm = await import('../runtimeFarm.js')
})

afterAll(() => {
  if (previousConfigDir === undefined) {
    delete process.env.OCC_CONFIG_DIR
  } else {
    process.env.OCC_CONFIG_DIR = previousConfigDir
  }
  rmSync(configDir, { recursive: true, force: true })
  rmSync(scratch, { recursive: true, force: true })
})

afterEach(() => {
  farm.setRuntimeFarmLinkerForTests()
  rmSync(join(configDir, 'runtime'), { recursive: true, force: true })
})

let packageSerial = 0

/**
 * A believable installed layout: `<prefix>/node_modules/@scope/pkg` holding
 * `dist/cli.js`, a chunk, an executable under `dist/vendor/`, and a
 * package.json — the four things the farm has to carry across.
 */
function makePackage(body = 'globalThis.__occFarmProbe = import.meta.url\n'): {
  packageRoot: string
  prefixModules: string
} {
  const prefix = join(scratch, `install-${packageSerial++}`)
  const prefixModules = join(prefix, 'node_modules')
  const packageRoot = join(prefixModules, '@scope', 'pkg')
  mkdirSync(join(packageRoot, 'dist', 'chunks'), { recursive: true })
  mkdirSync(join(packageRoot, 'dist', 'vendor'), { recursive: true })
  writeFileSync(join(packageRoot, 'dist', 'cli.js'), body)
  writeFileSync(join(packageRoot, 'dist', 'chunks', 'chunk-a.js'), 'a\n')
  writeFileSync(join(packageRoot, 'dist', 'vendor', 'rg'), '#!/bin/sh\n', {
    mode: 0o755,
  })
  writeFileSync(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@scope/pkg', version: '9.9.9' }),
  )
  mkdirSync(join(prefixModules, 'doubaoime-asr'), { recursive: true })
  return { packageRoot, prefixModules }
}

/**
 * The module loader reports realpaths, and macOS temp dirs are reached through
 * the `/var` → `/private/var` symlink, so compare on the tail rather than on
 * the absolute path.
 */
function expectLoadedFrom(expected: string): void {
  const loaded = (globalThis as Record<string, unknown>)
    .__occFarmProbe as string
  expect(loaded.endsWith(Bun.pathToFileURL(expected).href.slice(7))).toBe(true)
}

function farmNames(): string[] {
  try {
    return readdirSync(join(configDir, 'runtime')).sort()
  } catch {
    return []
  }
}

describe('ensureRuntimeFarm', () => {
  test('hard-links the whole dist tree into a versioned farm', () => {
    const { packageRoot } = makePackage()

    const farmDir = farm.ensureRuntimeFarm(packageRoot, '2.37.0')

    expect(farmDir.startsWith(join(configDir, 'runtime'))).toBe(true)
    expect(farmDir).toContain('2.37.0-')
    expect(existsSync(join(farmDir, 'dist', 'cli.js'))).toBe(true)
    expect(existsSync(join(farmDir, 'dist', 'chunks', 'chunk-a.js'))).toBe(true)

    // Same inode, two links: that is what lets the data survive the package
    // directory being deleted, and what makes the farm cost no extra disk.
    const source = statSync(join(packageRoot, 'dist', 'chunks', 'chunk-a.js'))
    const farmed = statSync(join(farmDir, 'dist', 'chunks', 'chunk-a.js'))
    expect(farmed.ino).toBe(source.ino)
    expect(farmed.nlink).toBe(2)
  })

  test('carries package.json so the farmed session reports the right version', () => {
    // getCurrentOccVersion() reads `<distRoot>/../package.json`.
    const { packageRoot } = makePackage()
    const farmDir = farm.ensureRuntimeFarm(packageRoot, '2.37.0')

    expect(
      JSON.parse(readFileSync(join(farmDir, 'package.json'), 'utf8')).version,
    ).toBe('9.9.9')
  })

  test('mirrors both node_modules trees onto the resolution path', () => {
    // A few specifiers survive bundling as bare dynamic imports
    // (doubaoime-asr, and the package.json dependencies). They resolve by
    // walking up from the importing chunk, which inside the farm would leave
    // the config dir entirely. Both the hoisted tree the package lives in and
    // the package's own nested one have to come along, in that lookup order.
    const { packageRoot } = makePackage()
    mkdirSync(join(packageRoot, 'node_modules', 'nested-dep'), {
      recursive: true,
    })
    const farmDir = farm.ensureRuntimeFarm(packageRoot, '2.37.0')

    const hoisted = join(farmDir, 'node_modules')
    expect(lstatSync(hoisted).isSymbolicLink()).toBe(true)
    expect(existsSync(join(hoisted, 'doubaoime-asr'))).toBe(true)

    const nested = join(farmDir, 'dist', 'node_modules')
    expect(lstatSync(nested).isSymbolicLink()).toBe(true)
    expect(existsSync(join(nested, 'nested-dep'))).toBe(true)
  })

  test('the second call reuses the farm without walking the tree', () => {
    const { packageRoot } = makePackage()
    const farmDir = farm.ensureRuntimeFarm(packageRoot, '2.37.0')

    // A file that appeared after the farm was built. If the warm path walked
    // the source tree it would show up; the whole startup budget depends on it
    // not doing that.
    writeFileSync(join(packageRoot, 'dist', 'chunks', 'chunk-late.js'), 'b\n')
    let links = 0
    farm.setRuntimeFarmLinkerForTests(() => {
      links++
    })

    expect(farm.ensureRuntimeFarm(packageRoot, '2.37.0')).toBe(farmDir)
    expect(links).toBe(0)
    expect(existsSync(join(farmDir, 'dist', 'chunks', 'chunk-late.js'))).toBe(
      false,
    )
    expect(farmNames()).toHaveLength(1)
  })

  test('a same-version reinstall with different bytes gets its own farm', () => {
    // Keying on the version alone would silently keep running the old code:
    // `npm install -g pkg@2.37.0` over a republished tarball leaves the name
    // untouched and the contents different.
    const { packageRoot } = makePackage()
    const first = farm.ensureRuntimeFarm(packageRoot, '2.37.0')

    writeFileSync(
      join(packageRoot, 'dist', 'cli.js'),
      'globalThis.__occFarmProbe = "reinstalled"\n',
    )
    const second = farm.ensureRuntimeFarm(packageRoot, '2.37.0')

    expect(second).not.toBe(first)
    expect(farmNames()).toHaveLength(2)
  })

  test.each([
    ['EXDEV', 'a config dir on another volume'],
    ['EPERM', 'a filesystem that refuses hard links'],
  ])('falls back to copying on %s (%s)', (code: string) => {
    const { packageRoot } = makePackage()
    let attempts = 0
    farm.setRuntimeFarmLinkerForTests(() => {
      attempts++
      throw Object.assign(new Error(`link failed: ${code}`), { code })
    })

    const farmDir = farm.ensureRuntimeFarm(packageRoot, '2.37.0')

    const farmed = statSync(join(farmDir, 'dist', 'chunks', 'chunk-a.js'))
    const source = statSync(join(packageRoot, 'dist', 'chunks', 'chunk-a.js'))
    expect(readFileSync(join(farmDir, 'dist', 'cli.js'), 'utf8')).toBe(
      readFileSync(join(packageRoot, 'dist', 'cli.js'), 'utf8'),
    )
    expect(farmed.ino).not.toBe(source.ino)
    // The verdict is filesystem-wide, so it is reached once rather than per
    // file — 600 doomed syscalls is not a rounding error at startup.
    expect(attempts).toBe(1)
    // Executables must stay executable or every search in the session breaks.
    expect(statSync(join(farmDir, 'dist', 'vendor', 'rg')).mode & 0o111).toBe(
      0o111,
    )
  })

  test('a link error that is not about the filesystem is not swallowed', () => {
    const { packageRoot } = makePackage()
    farm.setRuntimeFarmLinkerForTests(() => {
      throw Object.assign(new Error('no space left'), { code: 'ENOSPC' })
    })

    expect(() => farm.ensureRuntimeFarm(packageRoot, '2.37.0')).toThrow()
    // Nothing half-built is left behind for the next launch to adopt.
    expect(farmNames()).toEqual([])
  })
})

describe('runtimeFarmDirForDistRoot', () => {
  test('recognises a farm dist root and nothing else', () => {
    const { packageRoot } = makePackage()
    const farmDir = farm.ensureRuntimeFarm(packageRoot, '2.37.0')

    expect(farm.runtimeFarmDirForDistRoot(join(farmDir, 'dist'))).toBe(farmDir)
    expect(
      farm.runtimeFarmDirForDistRoot(join(packageRoot, 'dist')),
    ).toBeUndefined()
    // One level too deep is not a farm layout either.
    expect(
      farm.runtimeFarmDirForDistRoot(join(farmDir, 'dist', 'chunks')),
    ).toBeUndefined()
  })
})

describe('enterRuntimeFarm', () => {
  test('imports the entry from the farm, not from the package directory', async () => {
    const { packageRoot } = makePackage(
      'globalThis.__occFarmProbe = import.meta.url\n',
    )
    const entry = join(packageRoot, 'dist', 'cli-node.js')
    writeFileSync(entry, '')

    await farm.enterRuntimeFarm(Bun.pathToFileURL(entry).href, '2.37.0')

    const loaded = (globalThis as Record<string, unknown>)
      .__occFarmProbe as string
    expect(loaded).toContain('/runtime/2.37.0-')
    expect(loaded).not.toContain('/node_modules/@scope/pkg/dist/cli.js')
    expect(process.env.OCC_RUNTIME_FARM).toContain(join(configDir, 'runtime'))
  })

  test('a farmed copy runs from where it is instead of farming again', async () => {
    // The recursion guard. It is a path test rather than an env marker because
    // env is inherited by every child occ spawns, and a child launched through
    // the package bin would then skip the farm entirely.
    const farmsRoot = join(configDir, 'runtime')
    const alreadyFarmed = join(farmsRoot, '2.37.0-deadbeef')
    mkdirSync(join(alreadyFarmed, 'dist'), { recursive: true })
    writeFileSync(
      join(alreadyFarmed, 'dist', 'cli.js'),
      'globalThis.__occFarmProbe = import.meta.url\n',
    )
    const entry = join(alreadyFarmed, 'dist', 'cli-node.js')
    writeFileSync(entry, '')

    await farm.enterRuntimeFarm(Bun.pathToFileURL(entry).href, '2.37.0')

    expectLoadedFrom(join(alreadyFarmed, 'dist', 'cli.js'))
    expect(farmNames()).toEqual(['2.37.0-deadbeef'])
  })

  test('the marker also stops a child whose config dir moved from re-farming', async () => {
    // The path test alone asks "is this entry inside *my* farms root", and a
    // child started with a different OCC_CONFIG_DIR answers no — it would then
    // build a farm of a farm.
    const farmsRoot = join(configDir, 'runtime')
    const alreadyFarmed = join(farmsRoot, '2.37.0-feedface')
    mkdirSync(join(alreadyFarmed, 'dist'), { recursive: true })
    writeFileSync(
      join(alreadyFarmed, 'dist', 'cli.js'),
      'globalThis.__occFarmProbe = import.meta.url\n',
    )
    const entry = join(alreadyFarmed, 'dist', 'cli-node.js')
    writeFileSync(entry, '')
    const elsewhere = mkdtempSync(join(tmpdir(), 'occ-runtime-farm-alt-'))
    process.env.OCC_CONFIG_DIR = elsewhere
    process.env.OCC_RUNTIME_FARM = alreadyFarmed
    try {
      await farm.enterRuntimeFarm(Bun.pathToFileURL(entry).href, '2.37.0')
    } finally {
      process.env.OCC_CONFIG_DIR = configDir
      delete process.env.OCC_RUNTIME_FARM
      rmSync(elsewhere, { recursive: true, force: true })
    }

    expectLoadedFrom(join(alreadyFarmed, 'dist', 'cli.js'))
  })

  test('runs from the install tree when the farm cannot be built', async () => {
    // Degrading is mandatory: a farm that cannot be created must cost the user
    // nothing beyond losing the protection it would have provided.
    const { packageRoot } = makePackage()
    const entry = join(packageRoot, 'dist', 'cli-node.js')
    writeFileSync(entry, '')
    farm.setRuntimeFarmLinkerForTests(() => {
      throw Object.assign(new Error('no space left'), { code: 'ENOSPC' })
    })

    await farm.enterRuntimeFarm(Bun.pathToFileURL(entry).href, '2.37.0')

    expectLoadedFrom(join(packageRoot, 'dist', 'cli.js'))
  })

  test('OCC_DISABLE_RUNTIME_FARM keeps the session on the install tree', async () => {
    const { packageRoot } = makePackage()
    const entry = join(packageRoot, 'dist', 'cli-node.js')
    writeFileSync(entry, '')
    process.env.OCC_DISABLE_RUNTIME_FARM = '1'
    try {
      await farm.enterRuntimeFarm(Bun.pathToFileURL(entry).href, '2.37.0')
    } finally {
      delete process.env.OCC_DISABLE_RUNTIME_FARM
    }

    expectLoadedFrom(join(packageRoot, 'dist', 'cli.js'))
    expect(farmNames()).toEqual([])
  })
})
