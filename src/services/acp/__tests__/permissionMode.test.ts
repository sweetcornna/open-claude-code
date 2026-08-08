/**
 * Unit tests for the ACP session permission-mode resolver.
 *
 * The implicit mode (no `_meta.permissionMode`, no `permissions.defaultMode`)
 * used to be a bare `return 'auto'`. That bypassed every guard that
 * resolveInitialPermissionModeFallback exists to enforce — the
 * TRANSCRIPT_CLASSIFIER build flag, the auto-mode circuit breaker and
 * CLAUDE_CODE_REMOTE — so an ACP session could report 'auto' while the
 * classifier path was compiled out and the mode was pure decoration.
 *
 * Under `bun test`, `feature()` from bun:bundle is unbundled and returns false,
 * i.e. TRANSCRIPT_CLASSIFIER is compiled out. Every assertion below that
 * expects 'default' for the implicit case is therefore asserting the gate
 * actually fires — the old implementation returned 'auto' for all of them.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { resolveInitialPermissionModeFallback } from '../../../utils/permissions/PermissionMode.js'
import { resolveSessionPermissionMode } from '../agent/permissionMode.js'

const originalRemote = process.env.CLAUDE_CODE_REMOTE

afterEach(() => {
  if (originalRemote === undefined) {
    delete process.env.CLAUDE_CODE_REMOTE
  } else {
    process.env.CLAUDE_CODE_REMOTE = originalRemote
  }
})

describe('resolveSessionPermissionMode', () => {
  test('respects the auto-mode gate instead of hardcoding auto', () => {
    expect(resolveSessionPermissionMode(undefined, false, undefined)).toBe(
      'default',
    )
    expect(resolveSessionPermissionMode(undefined, false, null)).toBe('default')
  })

  test('stays on default in a remote (CCR) environment', () => {
    process.env.CLAUDE_CODE_REMOTE = '1'
    expect(resolveSessionPermissionMode(undefined, false, undefined)).toBe(
      'default',
    )
  })

  test('settings permissions.defaultMode still wins over the fallback', () => {
    expect(resolveSessionPermissionMode(undefined, false, 'acceptEdits')).toBe(
      'acceptEdits',
    )
    expect(resolveSessionPermissionMode(undefined, false, 'plan')).toBe('plan')
    // Explicit configuration is honored even when the gate would deny the
    // implicit fallback — the guards only govern the *implicit* choice.
    expect(resolveSessionPermissionMode(undefined, false, 'auto')).toBe('auto')
  })

  test('_meta.permissionMode wins over settings and the fallback', () => {
    expect(resolveSessionPermissionMode('plan', true, 'acceptEdits')).toBe(
      'plan',
    )
    expect(resolveSessionPermissionMode('auto', true, undefined)).toBe('auto')
  })

  test('an unparseable settings mode degrades to default, not to the fallback', () => {
    expect(resolveSessionPermissionMode(undefined, false, 'nonsense')).toBe(
      'default',
    )
  })
})

describe('ACP is treated as an interactive session', () => {
  /**
   * ACP sessions speak JSON-RPC over piped stdio, so the TTY-derived
   * getIsNonInteractiveSession() global reports "non-interactive" for them.
   * That global is the wrong signal here: the ACP client owns a live
   * `session/request_permission` channel (createAcpCanUseTool in
   * ../permissions.ts) and a human answers it in the editor, so the headless
   * argument for forcing 'default' does not apply. This pins the decision:
   * ACP passes isNonInteractiveSession: false, so with the classifier
   * available its implicit mode is auto — which is exactly what the headless
   * CLI path must NOT do.
   */
  const guardsSatisfied = {
    hasExplicitPermissionMode: false,
    autoModeSupported: true,
    autoModeCircuitBroken: false,
    isRemote: false,
  } as const

  test('interactive front ends (ACP) can reach auto; headless ones cannot', () => {
    expect(
      resolveInitialPermissionModeFallback({
        ...guardsSatisfied,
        isNonInteractiveSession: false,
      }),
    ).toBe('auto')

    expect(
      resolveInitialPermissionModeFallback({
        ...guardsSatisfied,
        isNonInteractiveSession: true,
      }),
    ).toBe('default')
  })
})
