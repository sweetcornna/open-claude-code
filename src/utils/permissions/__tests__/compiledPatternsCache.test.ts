import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}

const { matchingRuleForInput } = await import('../filesystem.js')
const { getEmptyToolPermissionContext } = await import('../../../Tool.js')

type Ctx = ReturnType<typeof getEmptyToolPermissionContext>

function contextWithRules(opts: { allow?: string[]; deny?: string[] }): Ctx {
  const ctx = getEmptyToolPermissionContext()
  return {
    ...ctx,
    ...(opts.allow ? { alwaysAllowRules: { localSettings: opts.allow } } : {}),
    ...(opts.deny ? { alwaysDenyRules: { localSettings: opts.deny } } : {}),
  } as Ctx
}

describe('compiled permission-pattern cache (2.1.208 parity)', () => {
  const target = `${process.cwd()}/src/generated/api.ts`

  test('repeated checks on the same context are decision-stable (cache hit)', () => {
    const ctx = contextWithRules({ allow: ['Edit(src/generated/**)'] })
    const first = matchingRuleForInput(target, ctx, 'edit', 'allow')
    const second = matchingRuleForInput(target, ctx, 'edit', 'allow')
    expect(first).not.toBeNull()
    expect(second).toEqual(first)
    expect(matchingRuleForInput(target, ctx, 'edit', 'deny')).toBeNull()
  })

  test('rule change → new context object → new decision takes effect immediately', () => {
    const allowCtx = contextWithRules({ allow: ['Edit(src/generated/**)'] })
    expect(
      matchingRuleForInput(target, allowCtx, 'edit', 'allow'),
    ).not.toBeNull()

    // Flip allow → deny the way the app does: a NEW context object.
    const denyCtx = contextWithRules({ deny: ['Edit(src/generated/**)'] })
    expect(matchingRuleForInput(target, denyCtx, 'edit', 'deny')).not.toBeNull()
    expect(matchingRuleForInput(target, denyCtx, 'edit', 'allow')).toBeNull()

    // The old context still answers per ITS rules (identity-keyed cache).
    expect(
      matchingRuleForInput(target, allowCtx, 'edit', 'allow'),
    ).not.toBeNull()
  })

  test('behavior kinds are cached under distinct keys on one context', () => {
    const ctx = contextWithRules({
      allow: ['Edit(src/generated/**)'],
      deny: ['Edit(secrets/**)'],
    })
    expect(matchingRuleForInput(target, ctx, 'edit', 'allow')).not.toBeNull()
    expect(matchingRuleForInput(target, ctx, 'edit', 'deny')).toBeNull()
    expect(
      matchingRuleForInput(
        `${process.cwd()}/secrets/key.pem`,
        ctx,
        'edit',
        'deny',
      ),
    ).not.toBeNull()
  })
})
