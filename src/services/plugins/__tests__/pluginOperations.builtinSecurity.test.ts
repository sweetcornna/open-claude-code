import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const originalOccConfigDir = process.env.OCC_CONFIG_DIR
let testRoot: string
let builtinPlugins: typeof import('../../../plugins/builtinPlugins.js')
let pluginOperations: typeof import('../pluginOperations.js')

beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'occ-builtin-plugin-security-'))
  process.env.OCC_CONFIG_DIR = testRoot
  builtinPlugins = await import('../../../plugins/builtinPlugins.js')
  pluginOperations = await import('../pluginOperations.js')
  builtinPlugins.clearBuiltinPlugins()
})

afterAll(async () => {
  builtinPlugins.clearBuiltinPlugins()
  if (originalOccConfigDir === undefined) {
    delete process.env.OCC_CONFIG_DIR
  } else {
    process.env.OCC_CONFIG_DIR = originalOccConfigDir
  }
  await rm(testRoot, { recursive: true, force: true })
})

describe('built-in plugin ID validation', () => {
  test('rejects malformed and unregistered builtin identifiers', async () => {
    for (const pluginId of [
      '@builtin',
      'missing@builtin',
      'evil@market@builtin',
    ]) {
      const result = await pluginOperations.setPluginEnabledOp(pluginId, true)
      expect(result.success).toBe(false)
      expect(result.pluginId).toBeUndefined()
    }
  })

  test('still enables an exactly registered builtin identifier', async () => {
    builtinPlugins.registerBuiltinPlugin({
      name: 'known',
      description: 'Known built-in plugin',
    })

    expect(builtinPlugins.isBuiltinPluginId('known@builtin')).toBe(true)
    const result = await pluginOperations.setPluginEnabledOp(
      'known@builtin',
      true,
    )
    expect(result.success).toBe(true)
    expect(result.pluginId).toBe('known@builtin')
  })
})
