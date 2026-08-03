import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'
import * as realSettings from 'src/utils/settings/settings.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
const settingsMock = makeSharedModuleMock(
  'src/utils/settings/settings.js',
  realSettings,
).setup()

const { cachePlugin, copyPluginToVersionedCache } = await import(
  '../pluginLoader.js'
)

const envNames = [
  'OCC_PLUGIN_CACHE_DIR',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
  'CLAUDE_CODE_PLUGIN_SEED_DIR',
  'CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE',
] as const
const savedEnv = new Map<string, string | undefined>()
let testRoot = ''

async function createPluginSource(
  name: string,
  markerName: string,
): Promise<string> {
  const source = join(testRoot, name)
  await mkdir(join(source, '.claude-plugin'), { recursive: true })
  await writeFile(
    join(source, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'same-name' }),
  )
  await writeFile(join(source, markerName), markerName)
  return source
}

beforeEach(async () => {
  for (const name of envNames) {
    savedEnv.set(name, process.env[name])
    delete process.env[name]
  }
  testRoot = await mkdtemp(join(tmpdir(), 'occ-plugin-cache-race-'))
  process.env.OCC_PLUGIN_CACHE_DIR = join(testRoot, 'plugins')
})

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true })
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  savedEnv.clear()
})

afterAll(() => {
  settingsMock.reset()
})

describe('parallel plugin cache publication', () => {
  test('keeps same-named downloads isolated by plugin ID and source', async () => {
    const sourceA = await createPluginSource('source-a', 'from-a.txt')
    const sourceB = await createPluginSource('source-b', 'from-b.txt')

    const [cachedA, cachedB] = await Promise.all([
      cachePlugin(sourceA, {
        manifest: { name: 'same-name' },
        pluginId: 'same-name@market-a',
      }),
      cachePlugin(sourceB, {
        manifest: { name: 'same-name' },
        pluginId: 'same-name@market-b',
      }),
    ])

    expect(cachedA.path).not.toBe(cachedB.path)
    expect(basename(cachedA.path)).toContain('same-name@market-a')
    expect(basename(cachedB.path)).toContain('same-name@market-b')
    expect(await readFile(join(cachedA.path, 'from-a.txt'), 'utf-8')).toBe(
      'from-a.txt',
    )
    expect(await readFile(join(cachedB.path, 'from-b.txt'), 'utf-8')).toBe(
      'from-b.txt',
    )
  })

  test('serializes writers for the same namespaced version cache key', async () => {
    const sourceA = await createPluginSource('version-a', 'from-a.txt')
    const sourceB = await createPluginSource('version-b', 'from-b.txt')

    const paths = await Promise.all([
      copyPluginToVersionedCache(sourceA, 'same-name@market-a', '1.0.0'),
      copyPluginToVersionedCache(sourceB, 'same-name@market-a', '1.0.0'),
    ])

    expect(paths[0]).toBe(paths[1])
    const entries = await readdir(paths[0]!)
    expect(entries.filter(entry => entry.startsWith('from-'))).toHaveLength(1)
  })
})
