import { describe, expect, test } from 'bun:test'
import { excludeStalePluginClients } from '../utils.js'
import type {
  ConfigScope,
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../types.js'

// Minimal shapes — this exercises the staleness predicate, not connection state.
function client(name: string, scope: ConfigScope, command = 'srv'): any {
  return {
    name,
    type: 'connected',
    config: { type: 'stdio', command, scope },
    client: {},
  }
}

function config(scope: ConfigScope, command = 'srv'): ScopedMcpServerConfig {
  return { type: 'stdio', command, scope } as ScopedMcpServerConfig
}

function mcpState(clients: MCPServerConnection[]) {
  return { clients, tools: [], commands: [], resources: {} }
}

describe('excludeStalePluginClients — removal', () => {
  test('a server deleted from .mcp.json is stale when its scope is authoritative', () => {
    // The whole point: before this, only scope 'dynamic' was ever reclaimed, so
    // deleting a project server from .mcp.json left its child process running.
    const { stale, clients } = excludeStalePluginClients(
      mcpState([client('gone', 'project')]),
      {},
      new Set<ConfigScope>(['project']),
    )
    expect(stale.map(s => s.name)).toEqual(['gone'])
    expect(clients).toHaveLength(0)
  })

  test('the same server survives when its scope was not enumerated', () => {
    // e.g. the claude.ai fetch was skipped, or .mcp.json failed to parse —
    // absence means "did not look", and tearing down live servers over that is
    // exactly the regression this guard prevents.
    const { stale, clients } = excludeStalePluginClients(
      mcpState([client('gone', 'project')]),
      {},
      new Set<ConfigScope>(['dynamic']),
    )
    expect(stale).toHaveLength(0)
    expect(clients).toHaveLength(1)
  })

  test('claudeai servers are never reclaimed by omission', () => {
    const { stale } = excludeStalePluginClients(
      mcpState([client('connector', 'claudeai')]),
      {},
      new Set<ConfigScope>(['dynamic', 'user', 'project', 'local']),
    )
    expect(stale).toHaveLength(0)
  })

  test('defaults to the old plugin-only behavior when no scopes are vouched for', () => {
    const { stale } = excludeStalePluginClients(
      mcpState([client('plug', 'dynamic'), client('proj', 'project')]),
      {},
    )
    expect(stale.map(s => s.name)).toEqual(['plug'])
  })
})

describe('excludeStalePluginClients — config change', () => {
  test('a changed config is stale in any scope, regardless of the vouched set', () => {
    const { stale } = excludeStalePluginClients(
      mcpState([client('srv', 'project', 'old-command')]),
      { srv: config('project', 'new-command') },
      new Set<ConfigScope>(),
    )
    expect(stale.map(s => s.name)).toEqual(['srv'])
  })

  test('an unchanged config is left alone', () => {
    const { stale } = excludeStalePluginClients(
      mcpState([client('srv', 'project')]),
      { srv: config('project') },
      new Set<ConfigScope>(['project']),
    )
    expect(stale).toHaveLength(0)
  })
})
