/**
 * Two ways a Bash deny/ask rule used to be sidesteppable:
 *
 *  1. No whitespace folding. The command side is normalized by the AST
 *     re-serialization inside extractOutputRedirections, but the *rule* side
 *     never was, so `deny: ["Bash(rm  -rf *)"]` (an extra space, easily typed)
 *     named no command at all.
 *  2. The legacy `Bash(rm:*)` spelling retries the match against
 *     "xargs <prefix>", so `xargs rm file` stays denied. The newer
 *     `Bash(rm *)` wildcard spelling did not, so switching syntax silently
 *     opened the bypass back up.
 */
import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { bashToolCheckPermission } = await import('../bashPermissions.js')
const { getEmptyToolPermissionContext } = await import('src/Tool.js')

type Ctx = ReturnType<typeof getEmptyToolPermissionContext>

function contextWithRules(opts: { allow?: string[]; deny?: string[] }): Ctx {
  const ctx = getEmptyToolPermissionContext()
  return {
    ...ctx,
    ...(opts.allow ? { alwaysAllowRules: { localSettings: opts.allow } } : {}),
    ...(opts.deny ? { alwaysDenyRules: { localSettings: opts.deny } } : {}),
  } as Ctx
}

function behaviorFor(command: string, ctx: Ctx): string {
  return bashToolCheckPermission({ command }, ctx).behavior
}

describe('bash rule matching folds whitespace on both sides', () => {
  test('a wildcard rule with doubled spaces still names the command', () => {
    const ctx = contextWithRules({ deny: ['Bash(rm  -rf *)'] })
    expect(behaviorFor('rm -rf /', ctx)).toBe('deny')
  })

  test('a prefix rule with doubled spaces still names the command', () => {
    const ctx = contextWithRules({ deny: ['Bash(git  push:*)'] })
    expect(behaviorFor('git push origin main', ctx)).toBe('deny')
  })

  test('tabs in a rule fold the same way as spaces', () => {
    const ctx = contextWithRules({ deny: ['Bash(rm\t-rf *)'] })
    expect(behaviorFor('rm -rf /', ctx)).toBe('deny')
  })

  test('re-spaced commands stay denied', () => {
    const ctx = contextWithRules({ deny: ['Bash(rm -rf *)'] })
    for (const command of ['rm -rf /', 'rm  -rf  /', 'rm\t-rf /']) {
      expect(behaviorFor(command, ctx)).toBe('deny')
    }
  })

  test('folding does not make unrelated commands match', () => {
    const ctx = contextWithRules({ deny: ['Bash(rm -rf *)'] })
    expect(behaviorFor('rmdir /tmp/x', ctx)).not.toBe('deny')
    expect(behaviorFor('echo rm -rf /', ctx)).not.toBe('deny')
  })
})

describe('xargs cannot launder a denied wildcard rule', () => {
  test('deny Bash(rm *) blocks "xargs rm file"', () => {
    const ctx = contextWithRules({ deny: ['Bash(rm *)'] })
    expect(behaviorFor('rm file', ctx)).toBe('deny')
    expect(behaviorFor('xargs rm file', ctx)).toBe('deny')
  })

  test('ask rules get the same retry', () => {
    const ctx = getEmptyToolPermissionContext()
    const askCtx = {
      ...ctx,
      alwaysAskRules: { localSettings: ['Bash(rm *)'] },
    } as Ctx
    expect(behaviorFor('xargs rm file', askCtx)).toBe('ask')
  })

  test('the legacy :* spelling behaves identically', () => {
    const ctx = contextWithRules({ deny: ['Bash(rm:*)'] })
    expect(behaviorFor('xargs rm file', ctx)).toBe('deny')
  })

  test('flagged xargs invocations are not confused for the bare form', () => {
    // "xargs -n1 rm file" does not start with "xargs rm", so the retry must
    // not match it — the compound/prefix machinery handles that case instead.
    const ctx = contextWithRules({ deny: ['Bash(rm *)'] })
    expect(behaviorFor('xargs -n1 rm file', ctx)).not.toBe('deny')
  })

  test('allow rules do not gain the xargs retry', () => {
    // Widening auto-approval is the wrong direction: `allow: ["Bash(ls *)"]`
    // must not silently approve `xargs ls`.
    const ctx = contextWithRules({ allow: ['Bash(nonreadonlycmd *)'] })
    expect(behaviorFor('nonreadonlycmd foo', ctx)).toBe('allow')
    expect(behaviorFor('xargs nonreadonlycmd foo', ctx)).not.toBe('allow')
  })
})
