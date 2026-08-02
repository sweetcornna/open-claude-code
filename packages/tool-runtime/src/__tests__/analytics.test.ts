import { describe, expect, mock, test } from 'bun:test'
import type { AnalyticsHost } from '../analytics.js'

async function loadFacade() {
  return import(`../analytics.ts?case=${Math.random()}`)
}

describe('analytics facade', () => {
  test('uses safe fallbacks when no host is registered', async () => {
    const facade = await loadFacade()

    expect(facade.logEvent('test_event', { count: 1 })).toBeUndefined()
    expect(facade.getFileExtensionForAnalytics('/tmp/example.TSX')).toBe('tsx')
    expect(
      facade.getFileExtensionForAnalytics('/tmp/example.verylongextension'),
    ).toBe('other')
    expect(facade.getFileExtensionForAnalytics('/tmp/README')).toBeUndefined()
  })

  test('delegates event logging to the registered host', async () => {
    const facade = await loadFacade()
    const host = {
      logEvent: mock((_eventName: string, _metadata: { count: number }) => {}),
    } satisfies AnalyticsHost

    facade.registerAnalyticsHost(host)
    facade.logEvent('test_event', { count: 2 })

    expect(host.logEvent).toHaveBeenCalledWith('test_event', { count: 2 })
  })
})
