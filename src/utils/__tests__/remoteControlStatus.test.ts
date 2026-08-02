import { describe, expect, test } from 'bun:test'
import { formatRemoteControlLocalStatus } from '../network/remoteControlStatus'

describe('formatRemoteControlLocalStatus', () => {
  test('reports the Happy-over-ACP model', () => {
    const out = formatRemoteControlLocalStatus()
    expect(out).toContain('Remote Control:')
    expect(out).toContain('via Happy over ACP')
    expect(out).toContain('agent=occ --acp')
  })

  test('reports the self-hosted server when HAPPY_SERVER_URL is set', () => {
    const prev = process.env.HAPPY_SERVER_URL
    process.env.HAPPY_SERVER_URL = 'https://happy.example.test'
    try {
      expect(formatRemoteControlLocalStatus()).toContain(
        'https://happy.example.test (self-hosted)',
      )
    } finally {
      if (prev === undefined) delete process.env.HAPPY_SERVER_URL
      else process.env.HAPPY_SERVER_URL = prev
    }
  })

  test('falls back to the hosted relay when unset', () => {
    const prev = process.env.HAPPY_SERVER_URL
    delete process.env.HAPPY_SERVER_URL
    try {
      expect(formatRemoteControlLocalStatus()).toContain(
        'default (Happy hosted relay)',
      )
    } finally {
      if (prev !== undefined) process.env.HAPPY_SERVER_URL = prev
    }
  })
})
