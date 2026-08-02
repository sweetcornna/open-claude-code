import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../tests/mocks/debug.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)

const { getPluginsDirectory } = await import('../pluginDirectories.js')

const envNames = [
  'OCC_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'OCC_PLUGIN_CACHE_DIR',
  'CLAUDE_CODE_PLUGIN_CACHE_DIR',
] as const

const savedEnv = new Map<string, string | undefined>()

beforeEach(() => {
  for (const name of envNames) {
    savedEnv.set(name, process.env[name])
    delete process.env[name]
  }
})

afterEach(() => {
  for (const name of envNames) {
    const value = savedEnv.get(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  savedEnv.clear()
})

describe('getPluginsDirectory', () => {
  test('defaults to the plugins directory under the occ config root', () => {
    expect(getPluginsDirectory()).toBe(join(homedir(), '.occ', 'plugins'))
  })

  test('uses OCC_PLUGIN_CACHE_DIR as the writable override', () => {
    process.env.OCC_PLUGIN_CACHE_DIR = '/tmp/occ-plugin-cache'
    expect(getPluginsDirectory()).toBe('/tmp/occ-plugin-cache')
  })

  test('never uses the legacy plugin cache override as a destination', () => {
    process.env.OCC_CONFIG_DIR = '/tmp/occ-config'
    process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR = '/tmp/official-plugin-cache'
    expect(getPluginsDirectory()).toBe('/tmp/occ-config/plugins')
    expect(getPluginsDirectory()).not.toBe('/tmp/official-plugin-cache')
  })
})
