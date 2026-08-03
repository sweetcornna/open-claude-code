import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { debugMock } from '../../../tests/mocks/debug.js'
import { logMock } from '../../../tests/mocks/log.js'
import { makeSharedModuleMock } from '../../../tests/mocks/sharedModuleMock.js'
import * as realSettings from 'src/utils/settings/settings.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

let settingsWriteCount = 0
const settingsMock = makeSharedModuleMock(
  'src/utils/settings/settings.js',
  realSettings,
).setup({
  getSettingsForSource: () => null,
  updateSettingsForSource: () => {
    settingsWriteCount += 1
    return { error: null }
  },
})

const { clearBuiltinPlugins, isBuiltinPluginId, registerBuiltinPlugin } =
  await import('../builtinPlugins.js')
const { setPluginEnabledOp } = await import(
  '../../services/plugins/pluginOperations.js'
)

beforeEach(() => {
  settingsWriteCount = 0
  clearBuiltinPlugins()
  registerBuiltinPlugin({
    name: 'known',
    description: 'Known built-in plugin',
  })
})

afterEach(() => {
  clearBuiltinPlugins()
})

afterAll(() => {
  settingsMock.reset()
})

describe('built-in plugin ID validation', () => {
  test('requires a valid ID, exact builtin marketplace, and registry entry', () => {
    expect(isBuiltinPluginId('known@builtin')).toBe(true)
    expect(isBuiltinPluginId('@builtin')).toBe(false)
    expect(isBuiltinPluginId('missing@builtin')).toBe(false)
    expect(isBuiltinPluginId('evil@market@builtin')).toBe(false)
    expect(isBuiltinPluginId('known@Builtin')).toBe(false)
  })

  test('does not persist malformed or unknown builtin IDs', async () => {
    for (const pluginId of [
      '@builtin',
      'missing@builtin',
      'evil@market@builtin',
    ]) {
      const result = await setPluginEnabledOp(pluginId, true)
      expect(result.success).toBe(false)
    }

    expect(settingsWriteCount).toBe(0)
  })
})
