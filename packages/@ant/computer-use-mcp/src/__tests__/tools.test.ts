import { describe, expect, test } from 'bun:test'
import { buildComputerUseTools } from '../tools.js'

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
