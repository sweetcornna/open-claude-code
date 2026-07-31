import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync } from 'fs'
import { debugMock } from '../../../../tests/mocks/debug'
import { stateMock } from '../../../../tests/mocks/state'

mock.module('src/utils/debug.ts', debugMock)

let globalConfig: Record<string, unknown> = {}
mock.module('src/utils/config.ts', () => ({
  getGlobalConfig: () => globalConfig,
  getCurrentProjectConfig: () => ({}),
  saveCurrentProjectConfig: () => {},
  saveGlobalConfig: () => {},
}))

// Spread the shared mock rather than replacing state.ts with a two-export
// stub: `mock.module` is process-global in Bun, so a partial mock here would
// break every other test file that loads bootstrap/state afterwards.
let nonInteractive = false
mock.module('src/bootstrap/state.ts', () => ({
  ...stateMock(),
  getIsNonInteractiveSession: () => nonInteractive,
}))

const {
  buildChromeDevtoolsArgs,
  resolveChromeDevtoolsCommand,
  setupChromeDevtools,
  shouldEnableChromeDevtools,
} = await import('../setup.js')
const {
  CHROME_DEVTOOLS_MCP_SERVER_NAME,
  CHROME_DEVTOOLS_READ_ONLY_TOOLS,
  CHROME_DEVTOOLS_TOOLS,
} = await import('../common.js')

const ENV_KEYS = [
  'CLAUDE_CODE_ENABLE_CFC',
  'OCC_CHROME_BROWSER_URL',
  'OCC_CHROME_AUTOCONNECT',
] as const
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  globalConfig = {}
  nonInteractive = false
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

describe('shouldEnableChromeDevtools', () => {
  test('is off by default', () => {
    expect(shouldEnableChromeDevtools(undefined)).toBe(false)
  })

  test('--chrome enables it', () => {
    expect(shouldEnableChromeDevtools(true)).toBe(true)
  })

  test('--no-chrome wins over every other source', () => {
    process.env.CLAUDE_CODE_ENABLE_CFC = '1'
    globalConfig = { chromeDevtoolsDefaultEnabled: true }
    expect(shouldEnableChromeDevtools(false)).toBe(false)
  })

  test('CLAUDE_CODE_ENABLE_CFC wins over the persisted default', () => {
    globalConfig = { chromeDevtoolsDefaultEnabled: true }
    process.env.CLAUDE_CODE_ENABLE_CFC = '0'
    expect(shouldEnableChromeDevtools(undefined)).toBe(false)
  })

  test('falls back to the persisted default', () => {
    globalConfig = { chromeDevtoolsDefaultEnabled: true }
    expect(shouldEnableChromeDevtools(undefined)).toBe(true)
  })

  test('non-interactive sessions stay off unless --chrome is explicit', () => {
    nonInteractive = true
    globalConfig = { chromeDevtoolsDefaultEnabled: true }
    process.env.CLAUDE_CODE_ENABLE_CFC = '1'
    expect(shouldEnableChromeDevtools(undefined)).toBe(false)
    expect(shouldEnableChromeDevtools(true)).toBe(true)
  })
})

describe('buildChromeDevtoolsArgs', () => {
  test('defaults to attaching to the running browser', () => {
    expect(buildChromeDevtoolsArgs()).toEqual([
      '--autoConnect',
      '--no-usage-statistics',
    ])
  })

  test('OCC_CHROME_BROWSER_URL switches to an explicit endpoint', () => {
    process.env.OCC_CHROME_BROWSER_URL = ' http://127.0.0.1:9222 '
    expect(buildChromeDevtoolsArgs()).toEqual([
      '--browserUrl',
      'http://127.0.0.1:9222',
      '--no-usage-statistics',
    ])
  })

  test('OCC_CHROME_AUTOCONNECT=0 lets the server launch its own browser', () => {
    process.env.OCC_CHROME_AUTOCONNECT = '0'
    expect(buildChromeDevtoolsArgs()).toEqual(['--no-usage-statistics'])
  })
})

describe('resolveChromeDevtoolsCommand', () => {
  test('resolves the bundled dependency rather than falling back to npx', () => {
    const { command, args, resolved } = resolveChromeDevtoolsCommand()
    expect(resolved).toBe(true)
    expect(command).not.toBe('npx')
    expect(args).toHaveLength(1)
    expect(args[0]).toContain('chrome-devtools-mcp')
    expect(existsSync(args[0] as string)).toBe(true)
  })
})

describe('setupChromeDevtools', () => {
  test('returns a stdio server under the documented name', () => {
    const { mcpConfig } = setupChromeDevtools()
    const server = mcpConfig[CHROME_DEVTOOLS_MCP_SERVER_NAME]
    expect(server).toBeDefined()
    expect(server?.type).toBe('stdio')
    expect(server?.scope).toBe('dynamic')
  })

  test('opts out of the upstream telemetry and update pings', () => {
    const server = setupChromeDevtools().mcpConfig[
      CHROME_DEVTOOLS_MCP_SERVER_NAME
    ] as { env?: Record<string, string>; args?: string[] }
    expect(server.env?.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS).toBe('1')
    expect(server.env?.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS).toBe('1')
    expect(server.args).toContain('--no-usage-statistics')
  })

  test('pre-approves only the observational tools', () => {
    const { allowedTools } = setupChromeDevtools()
    expect(allowedTools).toEqual(
      CHROME_DEVTOOLS_READ_ONLY_TOOLS.map(
        name => `mcp__chrome-devtools__${name}`,
      ),
    )
    // The tools that can act on the user's logged-in browser must keep
    // prompting — this is the whole permission story for the integration.
    for (const acting of [
      'click',
      'evaluate_script',
      'fill_form',
      'navigate_page',
      'press_key',
      'type_text',
      'upload_file',
    ]) {
      expect(allowedTools).not.toContain(`mcp__chrome-devtools__${acting}`)
    }
  })

  test('mentions the tool prefix in the system prompt', () => {
    expect(setupChromeDevtools().systemPrompt).toContain(
      'mcp__chrome-devtools__',
    )
  })
})

describe('CHROME_DEVTOOLS_READ_ONLY_TOOLS', () => {
  test('every pre-approved tool is one the server actually exposes', () => {
    for (const name of CHROME_DEVTOOLS_READ_ONLY_TOOLS) {
      expect(CHROME_DEVTOOLS_TOOLS).toContain(name)
    }
  })
})
