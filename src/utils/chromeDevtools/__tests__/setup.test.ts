import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { existsSync } from 'fs'
import { debugMock } from '../../../../tests/mocks/debug'
import { stateMockWith } from '../../../../tests/mocks/state'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock'
import * as realWhich from '../../process/which.js'
import { setupConfigMock } from '../../../../tests/mocks/config.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)

// Complete-surface mock so the process-global registry stays safe for other
// files; every export delegates to the real lookup unless overridden here.
const whichMock = makeSharedModuleMock<typeof realWhich>(
  'src/utils/process/which.ts',
  realWhich,
).setup()

let globalConfig: Record<string, unknown> = {}
const configMock = setupConfigMock({
  getGlobalConfig: () => globalConfig,
  getCurrentProjectConfig: () => ({}),
  saveCurrentProjectConfig: () => {},
  saveGlobalConfig: () => {},
})
afterAll(() => configMock.reset())

// Go through stateMockWith rather than hand-spreading: bootstrap/state.ts is a
// re-export barrel over @open-claude-code/tool-runtime, and on Linux (not
// macOS) mocking the barrel replaces the package module too. The helper builds
// a surface that delegates every non-overridden export to the real module, so
// that replacement is behaviour-preserving; a hand-written literal is what
// breaks later files in the shard.
let nonInteractive = false
mock.module(
  'src/bootstrap/state.ts',
  stateMockWith({ getIsNonInteractiveSession: () => nonInteractive }),
)

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
  whichMock.reset()
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

  test('falls back to the running binary when node is absent from PATH', () => {
    // `occ-bun` is the only entry a Bun-only machine can launch (`occ` itself
    // is `#!/usr/bin/env node`), and those machines have no `node`. Naming it
    // regardless made `--chrome` die with `spawn node ENOENT` there.
    whichMock.set({ whichSync: () => null })
    const { command, resolved } = resolveChromeDevtoolsCommand()
    expect(resolved).toBe(true)
    expect(command).toBe(process.execPath)
    expect(existsSync(command)).toBe(true)
  })

  test('prefers the node on PATH when there is one', () => {
    whichMock.set({ whichSync: () => '/opt/custom/bin/node' })
    // The Node build never looks: the interpreter already running IS node, and
    // it is version-matched to the install.
    expect(resolveChromeDevtoolsCommand().command).toBe(
      process.versions.bun ? '/opt/custom/bin/node' : process.execPath,
    )
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
