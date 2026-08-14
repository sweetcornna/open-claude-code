import { describe, expect, test } from 'bun:test'
import type { LoadedPlugin } from '../../../types/plugin.js'
import type { PluginDetails } from '../../../utils/plugins/pluginDetails.js'
import { renderPluginDetails, resolvePluginByName } from '../detailsCommand.js'

function plugin(source: string, name: string): LoadedPlugin {
  return {
    name,
    manifest: { name },
    path: `/plugins/${name}`,
    source,
    repository: source,
  }
}

describe('resolvePluginByName', () => {
  const plugins = [
    plugin('formatter@alpha', 'formatter'),
    plugin('formatter@beta', 'formatter'),
    plugin('linter@alpha', 'linter'),
  ]

  test('matches the fully qualified id exactly', () => {
    const result = resolvePluginByName(plugins, 'formatter@beta')
    expect(result).toEqual({ kind: 'found', plugin: plugins[1]! })
  })

  test('matches a unique bare name', () => {
    const result = resolvePluginByName(plugins, 'linter')
    expect(result).toEqual({ kind: 'found', plugin: plugins[2]! })
  })

  test('refuses a bare name that two marketplaces both claim', () => {
    // Guessing here would price the wrong component set — the two plugins
    // share only a name.
    expect(resolvePluginByName(plugins, 'formatter')).toEqual({
      kind: 'ambiguous',
      matches: ['formatter@alpha', 'formatter@beta'],
    })
  })

  test('a qualified id that matches nothing does not fall back to the name', () => {
    expect(resolvePluginByName(plugins, 'formatter@gamma')).toEqual({
      kind: 'not-found',
    })
  })

  test('reports not-found for an unknown plugin', () => {
    expect(resolvePluginByName(plugins, 'nope')).toEqual({ kind: 'not-found' })
  })
})

function details(overrides: Partial<PluginDetails> = {}): PluginDetails {
  return {
    pluginId: 'demo@market',
    name: 'demo',
    version: '1.0.0',
    path: '/plugins/demo',
    enabled: true,
    skills: [
      {
        kind: 'skill',
        name: 'demo:greeter',
        alwaysOnLine: '- demo:greeter: Greets',
        alwaysOnChars: 22,
        onInvokeChars: 900,
        listed: true,
      },
    ],
    commands: [
      {
        kind: 'command',
        name: 'demo:bare',
        alwaysOnLine: '',
        alwaysOnChars: 0,
        onInvokeChars: 100,
        listed: false,
      },
    ],
    agents: [],
    hooks: ['PreToolUse'],
    mcpServers: ['demo-server'],
    lspServers: [],
    cost: {
      alwaysOnChars: 22,
      onInvokeChars: 1000,
      alwaysOnTokens: 6,
      onInvokeTokens: 250,
      tokenSource: 'api',
      budgetChars: 8000,
      contextWindowTokens: 200_000,
      shareOfBudget: 22 / 8000,
    },
    ...overrides,
  }
}

describe('renderPluginDetails', () => {
  test('separates what you pay every turn from what you pay on invoke', () => {
    const out = renderPluginDetails(details())
    expect(out).toContain('always_on:  22 chars / 6 tokens')
    expect(out).toContain('on_invoke:  1,000 chars')
    expect(out).toContain('paid only when a component is actually invoked')
    expect(out).toContain('0.3% of the 8,000-char skill listing budget')
  })

  test('flags a component that never reaches the listing', () => {
    const out = renderPluginDetails(details())
    expect(out).toContain('demo:bare — always_on 0 chars (not listed')
  })

  test('says so when the tokens are estimated rather than counted', () => {
    const base = details()
    const out = renderPluginDetails({
      ...base,
      cost: { ...base.cost, tokenSource: 'chars' },
    })
    expect(out).toContain('estimated from characters')
  })

  test('does not claim a disabled plugin is costing anything today', () => {
    const out = renderPluginDetails(details({ enabled: false }))
    expect(out).toContain('disabled')
    expect(out).toContain('what enabling it would add')
  })

  test('lists hooks and MCP servers by name', () => {
    const out = renderPluginDetails(details())
    expect(out).toContain('Hooks (1): PreToolUse')
    expect(out).toContain('MCP servers (1): demo-server')
    expect(out).not.toContain('LSP servers')
  })

  test('a plugin with no components renders without an empty section', () => {
    const out = renderPluginDetails(
      details({
        skills: [],
        commands: [],
        agents: [],
        hooks: [],
        mcpServers: [],
      }),
    )
    expect(out).toContain('Components:\n  (none)')
  })
})
