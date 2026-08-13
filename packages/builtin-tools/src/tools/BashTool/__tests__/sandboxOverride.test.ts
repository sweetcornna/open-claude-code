import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'
import type { PermissionResult } from '@open-claude-code/tool-runtime/permissions/PermissionResult.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { maybeForceSandboxOverrideAsk } = await import('../bashPermissions.js')

// maybeForceSandboxOverrideAsk restores the producer for the `sandboxOverride`
// decision reason: when the model sets dangerouslyDisableSandbox to escape a
// sandbox that would otherwise apply, it forces a confirmation prompt instead
// of silently running unsandboxed (matching the Bash prompt's own promise).

// Minimal fixture: maybeForceSandboxOverrideAsk only reads `command` and
// `dangerouslyDisableSandbox`, so a partial object cast to the schema type is
// enough (no `any` — derive the exact param type from the function signature).
type BashInput = Parameters<typeof maybeForceSandboxOverrideAsk>[0]
const input = (command: string, flag?: boolean): BashInput =>
  ({ command, dangerouslyDisableSandbox: flag }) as unknown as BashInput

// Models "would be sandboxed unless the flag disables it": true when the flag
// is absent/false, false when set — i.e. there is a sandbox to escape.
const wouldSandboxUnlessEscaped = (i: {
  dangerouslyDisableSandbox?: boolean
}): boolean => !i.dangerouslyDisableSandbox
// Models "sandbox off entirely": nothing is ever sandboxed.
const neverSandbox = (): boolean => false

const allow: PermissionResult = {
  behavior: 'allow',
  updatedInput: {},
  decisionReason: { type: 'other', reason: 'requires approval' },
}

describe('maybeForceSandboxOverrideAsk', () => {
  test('forces an ask when the model escapes an otherwise-sandboxed command', () => {
    const r = maybeForceSandboxOverrideAsk(
      input('rm -rf build', true),
      allow,
      wouldSandboxUnlessEscaped,
    )
    expect(r.behavior).toBe('ask')
    expect(r.decisionReason).toEqual({
      type: 'sandboxOverride',
      reason: 'dangerouslyDisableSandbox',
    })
    expect(r.behavior === 'ask' && r.message).toBe('Run outside of the sandbox')
  })

  test('does not override an explicit allow rule', () => {
    const ruleAllow: PermissionResult = {
      behavior: 'allow',
      updatedInput: {},
      decisionReason: { type: 'rule', rule: {} as never },
    }
    const r = maybeForceSandboxOverrideAsk(
      input('git status', true),
      ruleAllow,
      wouldSandboxUnlessEscaped,
    )
    expect(r).toBe(ruleAllow)
  })

  test('does not override when every subcommand result is rule-based', () => {
    const reasons = new Map<string, PermissionResult>([
      [
        'git status',
        {
          behavior: 'allow',
          updatedInput: {},
          decisionReason: { type: 'rule', rule: {} as never },
        },
      ],
    ])
    const subAllow: PermissionResult = {
      behavior: 'allow',
      updatedInput: {},
      decisionReason: { type: 'subcommandResults', reasons },
    }
    const r = maybeForceSandboxOverrideAsk(
      input('git status && ls', true),
      subAllow,
      wouldSandboxUnlessEscaped,
    )
    expect(r).toBe(subAllow)
  })

  test('overrides when a subcommand result is not rule-based', () => {
    const reasons = new Map<string, PermissionResult>([
      [
        'x',
        {
          behavior: 'allow',
          updatedInput: {},
          decisionReason: { type: 'other', reason: 'y' },
        },
      ],
    ])
    const subAllow: PermissionResult = {
      behavior: 'allow',
      updatedInput: {},
      decisionReason: { type: 'subcommandResults', reasons },
    }
    const r = maybeForceSandboxOverrideAsk(
      input('x', true),
      subAllow,
      wouldSandboxUnlessEscaped,
    )
    expect(r.behavior).toBe('ask')
  })

  test('leaves deny and ask base decisions untouched', () => {
    const deny: PermissionResult = {
      behavior: 'deny',
      message: 'denied',
      decisionReason: { type: 'other', reason: 'z' },
    }
    expect(
      maybeForceSandboxOverrideAsk(
        input('rm', true),
        deny,
        wouldSandboxUnlessEscaped,
      ),
    ).toBe(deny)
    const ask: PermissionResult = {
      behavior: 'ask',
      message: 'ask?',
      decisionReason: { type: 'other', reason: 'z' },
    }
    expect(
      maybeForceSandboxOverrideAsk(
        input('rm', true),
        ask,
        wouldSandboxUnlessEscaped,
      ),
    ).toBe(ask)
  })

  test('no-op when the flag is not set', () => {
    const r = maybeForceSandboxOverrideAsk(
      input('rm -rf build', false),
      allow,
      wouldSandboxUnlessEscaped,
    )
    expect(r).toBe(allow)
  })

  test('no-op when the command would not be sandboxed anyway', () => {
    const r = maybeForceSandboxOverrideAsk(
      input('echo hi', true),
      allow,
      neverSandbox,
    )
    expect(r).toBe(allow)
  })
})
