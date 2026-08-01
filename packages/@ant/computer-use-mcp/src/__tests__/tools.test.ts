import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { describe, expect, test } from 'bun:test'
import { createComputerUseMcpServer } from '../mcpServer.js'
import { buildComputerUseTools } from '../tools.js'
import type {
  ComputerUseHostAdapter,
  ComputerUseSessionContext,
} from '../types.js'

function createFakeAdapter(
  isDisabled: () => boolean,
  ensureOsPermissions: ComputerUseHostAdapter['ensureOsPermissions'] = async () => ({
    granted: true,
  }),
): ComputerUseHostAdapter {
  return {
    serverName: 'computer-use-test',
    logger: {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      silly: () => {},
    },
    executor: {
      capabilities: { screenshotFiltering: 'none', platform: 'win32' },
    } as unknown as ComputerUseHostAdapter['executor'],
    ensureOsPermissions,
    isDisabled,
    getAutoUnhideEnabled: () => false,
    getSubGates: () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: false,
    }),
    cropRawPatch: () => null,
  }
}

const emptySessionContext: ComputerUseSessionContext = {
  getAllowedApps: () => [],
  getGrantFlags: () => ({
    clipboardRead: false,
    clipboardWrite: false,
    systemKeyCombos: false,
  }),
  getUserDeniedBundleIds: () => [],
  getSelectedDisplayId: () => undefined,
}

describe('buildComputerUseTools', () => {
  test('exposes the host CLI without invoking the official Claude binary', () => {
    const tools = buildComputerUseTools(
      { screenshotFiltering: 'none', platform: 'win32' },
      'pixels',
    )
    const openTerminal = tools.find(tool => tool.name === 'open_terminal')
    const schema = openTerminal?.inputSchema as {
      properties?: { agent?: { enum?: string[]; description?: string } }
    }

    expect(schema.properties?.agent?.enum).toEqual([
      'self',
      'codex',
      'gemini',
      'custom',
    ])
    expect(schema.properties?.agent?.enum).not.toContain('claude')
    expect(schema.properties?.agent?.description).toContain(
      'self: runs the current host CLI',
    )
  })
})

describe('createComputerUseMcpServer', () => {
  test('lists tools and reflects the disabled state over the wire', async () => {
    let disabled = false
    const adapter = createFakeAdapter(() => disabled)
    const server = createComputerUseMcpServer(adapter, 'pixels')
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    const client = new Client(
      { name: 'test', version: '1.0.0' },
      { capabilities: {} },
    )

    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)

      const enabledResult = await client.listTools()
      expect(enabledResult.tools.map(tool => tool.name)).toContain('screenshot')

      disabled = true
      expect((await client.listTools()).tools).toEqual([])
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('strips bound-session piggyback fields from call results', async () => {
    const adapter = createFakeAdapter(
      () => false,
      async () => ({
        granted: false,
        accessibility: false,
        screenRecording: false,
      }),
    )
    const server = createComputerUseMcpServer(
      adapter,
      'pixels',
      emptySessionContext,
    )
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    const client = new Client(
      { name: 'test', version: '1.0.0' },
      { capabilities: {} },
    )

    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)

      const result = await client.callTool({
        name: 'screenshot',
        arguments: {},
      })
      const text = result.content.find(item => item.type === 'text')?.text

      expect(result.isError).toBe(true)
      expect(text).toContain(
        'Accessibility and Screen Recording permissions are required',
      )
      expect(result).not.toHaveProperty('screenshot')
      expect(result).not.toHaveProperty('telemetry')
    } finally {
      await client.close()
      await server.close()
    }
  })

  test('returns the no-context stub error over the wire', async () => {
    const adapter = createFakeAdapter(() => false)
    const server = createComputerUseMcpServer(adapter, 'pixels')
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair()
    const client = new Client(
      { name: 'test', version: '1.0.0' },
      { capabilities: {} },
    )

    try {
      await server.connect(serverTransport)
      await client.connect(clientTransport)

      const result = await client.callTool({
        name: 'screenshot',
        arguments: {},
      })
      const text = result.content.find(item => item.type === 'text')?.text

      expect(result.isError).toBe(true)
      expect(text).toContain('not wired to a session')
    } finally {
      await client.close()
      await server.close()
    }
  })
})
