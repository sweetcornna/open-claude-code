import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { logMock } from '../../../../../../tests/mocks/log'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const { WebFetchTool } = await import('../WebFetchTool.js')
const { getEmptyToolPermissionContext } = await import('src/Tool.js')

type PermissionContext = ReturnType<typeof getEmptyToolPermissionContext>

async function check(
  url: string,
  rules: Partial<PermissionContext> = {},
): Promise<{ behavior: string; decisionReason?: unknown }> {
  const permissionContext = {
    ...getEmptyToolPermissionContext(),
    ...rules,
  } as PermissionContext
  return (
    WebFetchTool as unknown as {
      checkPermissions: (
        input: { url: string; prompt: string },
        context: {
          getAppState: () => { toolPermissionContext: PermissionContext }
        },
      ) => Promise<{ behavior: string; decisionReason?: unknown }>
    }
  ).checkPermissions(
    { url, prompt: 'summarize' },
    { getAppState: () => ({ toolPermissionContext: permissionContext }) },
  )
}

describe('WebFetchTool permission precedence', () => {
  test('an explicit deny overrides a preapproved host', async () => {
    const decision = await check('https://developer.mozilla.org/en-US/docs', {
      alwaysDenyRules: {
        localSettings: ['WebFetch(domain:developer.mozilla.org)'],
      },
    } as Partial<PermissionContext>)

    expect(decision.behavior).toBe('deny')
  })

  test('an explicit ask overrides a preapproved host', async () => {
    const decision = await check('https://developer.mozilla.org/en-US/docs', {
      alwaysAskRules: {
        localSettings: ['WebFetch(domain:developer.mozilla.org)'],
      },
    } as Partial<PermissionContext>)

    expect(decision.behavior).toBe('ask')
  })

  test('a wildcard deny matches nested subdomains', async () => {
    const decision = await check('https://api.docs.example.com/reference', {
      alwaysDenyRules: {
        localSettings: ['WebFetch(domain:*.example.com)'],
      },
    } as Partial<PermissionContext>)

    expect(decision.behavior).toBe('deny')
  })

  test('a wildcard subdomain rule does not match the apex domain', async () => {
    const decision = await check('https://example.com/reference', {
      alwaysDenyRules: {
        localSettings: ['WebFetch(domain:*.example.com)'],
      },
    } as Partial<PermissionContext>)

    expect(decision.behavior).toBe('ask')
  })

  test('domain rules normalize case and a trailing dot', async () => {
    const decision = await check('https://developer.mozilla.org/en-US/docs', {
      alwaysDenyRules: {
        localSettings: ['WebFetch(domain:DEVELOPER.MOZILLA.ORG.)'],
      },
    } as Partial<PermissionContext>)

    expect(decision.behavior).toBe('deny')
  })

  test('preapproved hosts remain allowed without an explicit rule', async () => {
    const decision = await check('https://developer.mozilla.org/en-US/docs')

    expect(decision).toMatchObject({
      behavior: 'allow',
      decisionReason: { type: 'other', reason: 'Preapproved host' },
    })
  })
})
