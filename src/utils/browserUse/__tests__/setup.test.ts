import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/debug.ts', debugMock)

const { setupBrowserUse } = await import('../setup.js')
const { BROWSER_USE_READ_ONLY_TOOLS, BROWSER_USE_TOOLS } = await import(
  '../common.js'
)

describe('setupBrowserUse', () => {
  test('launches the MCP module, not the documented --mcp flag', () => {
    // browser-use's own docs say `browser-use --mcp`. That flag does not exist
    // in 0.13.7 — its CLI has only --version/--doctor/auth/skill, so the
    // documented command starts nothing. Verified against a live MCP
    // initialize handshake; pinned here so nobody "fixes" it back to the docs.
    const server = setupBrowserUse().mcpConfig['browser-use'] as {
      command: string
      args: string[]
    }
    expect(server.command).toBe('uvx')
    expect(server.args).toEqual([
      '--from',
      'browser-use[cli]',
      'python',
      '-m',
      'browser_use.mcp.server',
    ])
    expect(server.args).not.toContain('--mcp')
  })

  test('every pre-approved tool is one the server actually exposes', () => {
    // An allowlist entry naming a tool that does not exist is silently inert:
    // no error, just an unexpected permission prompt much later.
    for (const name of BROWSER_USE_READ_ONLY_TOOLS) {
      expect(BROWSER_USE_TOOLS).toContain(name)
    }
  })

  test('pre-approves only observational tools', () => {
    const { allowedTools } = setupBrowserUse()
    expect(allowedTools).toEqual(
      BROWSER_USE_READ_ONLY_TOOLS.map(name => `mcp__browser-use__${name}`),
    )
    // Anything that acts on the page — or hands the whole task to an
    // autonomous agent — must keep prompting.
    for (const acting of [
      'browser_navigate',
      'browser_click',
      'browser_type',
      'browser_close_tab',
      'browser_close_all',
      'retry_with_browser_use_agent',
    ]) {
      expect(allowedTools).not.toContain(`mcp__browser-use__${acting}`)
    }
  })

  test('forwards the credentials it is given and nothing else', () => {
    const server = setupBrowserUse({ ANTHROPIC_AUTH_TOKEN: 'tok' }).mcpConfig[
      'browser-use'
    ] as { env?: Record<string, string> }
    expect(server.env).toEqual({ ANTHROPIC_AUTH_TOKEN: 'tok' })
  })
})
