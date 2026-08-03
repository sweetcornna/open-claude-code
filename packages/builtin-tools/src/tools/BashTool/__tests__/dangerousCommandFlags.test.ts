import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

// MACRO is a build-time define (see pathValidation.test.ts for rationale) —
// checkReadableInternalPath dereferences MACRO.VERSION on path validation.
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}

const { checkPathConstraints } = await import('../pathValidation.js')
const { getEmptyToolPermissionContext } = await import('src/Tool.js')

function check(command: string) {
  return checkPathConstraints(
    { command } as never,
    '/tmp/project',
    getEmptyToolPermissionContext(),
  )
}

describe('dangerous command-flag gates (allow rules cannot auto-approve)', () => {
  test('find execution/write flags force ask (2.1.113 parity)', () => {
    for (const cmd of [
      'find . -name "*.tmp" -delete',
      'find /srv -exec rm {} \\;',
      'find . -execdir chmod +x {} \\;',
      'find . -fprint /tmp/out.txt',
    ]) {
      const result = check(cmd)
      expect(result.behavior).toBe('ask')
      expect(result.behavior === 'ask' ? result.message : '').toContain(
        'requires explicit approval',
      )
    }
  })

  test('plain find is not caught by the flag gate', () => {
    // The generic path checker may still ask (empty permission context), but
    // the decision must not come from the dangerous-flag gate.
    const result = check('find . -name "*.ts" -type f')
    const reason =
      result.decisionReason?.type === 'other'
        ? result.decisionReason.reason
        : ''
    expect(reason).not.toContain('Dangerous find flag')
  })

  test('docker/podman daemon redirection flags force ask (2.1.214 parity)', () => {
    for (const cmd of [
      'docker --host tcp://evil:2375 ps',
      'docker --host=tcp://evil:2375 ps',
      'docker -H tcp://evil:2375 images',
      'docker --context prod-cluster ps',
      'podman --url ssh://evil/run/podman.sock ps',
      'podman --remote ps',
      'podman --connection prod ps',
    ]) {
      const result = check(cmd)
      expect(result.behavior).toBe('ask')
    }
  })

  test('plain docker/podman pass through', () => {
    expect(check('docker ps').behavior).toBe('passthrough')
    expect(check('podman images').behavior).toBe('passthrough')
  })

  test('file magic/list flags force ask; flags on other commands unaffected', () => {
    for (const cmd of [
      'file -m evil.magic target.bin',
      'file --files-from list.txt',
    ]) {
      const result = check(cmd)
      expect(result.behavior).toBe('ask')
      expect(
        result.decisionReason?.type === 'other'
          ? result.decisionReason.reason
          : '',
      ).toContain('Dangerous file flag')
    }
    // -f is gated only for `file` — tail -f never hits the flag gate
    const tail = check('tail -f /tmp/project/log.txt')
    const tailReason =
      tail.decisionReason?.type === 'other' ? tail.decisionReason.reason : ''
    expect(tailReason).not.toContain('Dangerous')
  })

  test('wrapper stripping still applies before the gate', () => {
    expect(check('timeout 10 find . -delete').behavior).toBe('ask')
  })
})
