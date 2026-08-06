import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

// Complete-surface shared mocks — Bun's module registry is process-global and
// last-write-wins, so a partial surface here would poison later importers.
import * as realConfig from 'src/utils/config/config.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'

const configMock = makeSharedModuleMock(
  'src/utils/config/config.js',
  realConfig,
).setup()
const settingsMock = setupSettingsMock()

const { parseMcpConfig } = await import('../config')

const KEY = 'MCP_CONFIG_EXPANSION_TEST_KEY'
// Built at runtime so this file's own source never contains the literal.
const placeholder = (name: string): string => '$' + '{' + name + '}'

let savedKey: string | undefined

beforeEach(() => {
  savedKey = process.env[KEY]
  delete process.env[KEY]
})

afterAll(() => {
  if (savedKey === undefined) delete process.env[KEY]
  else process.env[KEY] = savedKey
  configMock.reset()
  settingsMock.reset()
})

function parseStdioServer(env: Record<string, string>): {
  env?: Record<string, string>
  missing: string[]
} {
  const { config, errors } = parseMcpConfig({
    configObject: {
      mcpServers: {
        fred: { type: 'stdio', command: 'server', args: [], env },
      },
    },
    expandVars: true,
    scope: 'project',
  })
  const server = config?.mcpServers?.fred as
    | { env?: Record<string, string> }
    | undefined
  return {
    env: server?.env,
    missing: errors.map(e => e.message),
  }
}

describe('parseMcpConfig env expansion', () => {
  /**
   * The bug this pins: rootAction kicks the MCP config read off during startup,
   * hundreds of lines before showSetupScreens() runs the trust dialog and
   * applyConfigEnvironmentVariables() copies project-scoped settings.env into
   * process.env. Expanding against process.env alone left the placeholder
   * literal in the snapshot that prefetchAllMcpResources then spawned, while
   * the post-trust re-read expanded it properly — connectToServer's
   * config-keyed memoize saw two different configs and left two live child
   * processes per server, the literal one answering tool calls.
   */
  test('expands from settings.env even when process.env has not been populated yet', () => {
    settingsMock.set({
      getSettings_DEPRECATED: () => ({ env: { [KEY]: 'real-api-key' } }),
    })

    const { env, missing } = parseStdioServer({
      FRED_API_KEY: placeholder(KEY),
    })

    expect(env).toEqual({ FRED_API_KEY: 'real-api-key' })
    expect(missing).toEqual([])
  })

  test('produces the same config before and after the var lands in process.env', () => {
    settingsMock.set({
      getSettings_DEPRECATED: () => ({ env: { [KEY]: 'real-api-key' } }),
    })

    const beforeTrust = parseStdioServer({ FRED_API_KEY: placeholder(KEY) })
    // What applyConfigEnvironmentVariables() does once trust is established.
    process.env[KEY] = 'real-api-key'
    const afterTrust = parseStdioServer({ FRED_API_KEY: placeholder(KEY) })

    // Identical configs mean one connectToServer cache key, so one child
    // process per server rather than one per parse.
    expect(beforeTrust.env).toEqual(afterTrust.env)
  })

  test('still reports a variable no source defines', () => {
    settingsMock.set({ getSettings_DEPRECATED: () => ({ env: {} }) })

    const { env, missing } = parseStdioServer({
      FRED_API_KEY: placeholder(KEY),
    })

    expect(env).toEqual({ FRED_API_KEY: placeholder(KEY) })
    expect(missing.join(' ')).toContain(KEY)
  })
})
