import { describe, expect, mock, test } from 'bun:test'
import type { SlowOperationsHost } from '../slowOperations.js'

async function loadFacade() {
  return import(`../slowOperations.ts?case=${Math.random()}`)
}

describe('slowOperations facade', () => {
  test('uses native JSON operations when no host is registered', async () => {
    const facade = await loadFacade()

    expect(facade.jsonParse('{"count":2}')).toEqual({ count: 2 })
    expect(facade.jsonStringify({ count: 2 }, null, 2)).toBe(
      '{\n  "count": 2\n}',
    )
  })

  test('delegates to the registered host', async () => {
    const facade = await loadFacade()
    const host = {
      jsonParse: mock((text: string) => ({ delegatedParse: text })),
      jsonStringify: mock((_value: unknown) => 'delegated stringify'),
    } satisfies SlowOperationsHost

    facade.registerSlowOperationsHost(host)

    expect(facade.jsonParse('{"count":2}')).toEqual({
      delegatedParse: '{"count":2}',
    })
    expect(facade.jsonStringify({ count: 2 }, null, 2)).toBe(
      'delegated stringify',
    )
    expect(host.jsonParse).toHaveBeenCalledWith('{"count":2}', undefined)
    expect(host.jsonStringify).toHaveBeenCalledWith({ count: 2 }, null, 2)
  })
})
