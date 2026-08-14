/**
 * The managed version gate. Pure function, no mocks.
 */
import { describe, expect, test } from 'bun:test'
import { evaluateVersionGate } from '../versionGate.js'

describe('evaluateVersionGate', () => {
  test('allows a version inside the range', () => {
    expect(
      evaluateVersionGate({
        current: '2.44.0',
        minimum: '2.40.0',
        maximum: '2.50.0',
      }),
    ).toBeNull()
  })

  test('allows the boundaries themselves', () => {
    expect(
      evaluateVersionGate({ current: '2.44.0', minimum: '2.44.0' }),
    ).toBeNull()
    expect(
      evaluateVersionGate({ current: '2.44.0', maximum: '2.44.0' }),
    ).toBeNull()
  })

  test('blocks a build older than requiredMinimumVersion and says so', () => {
    const message = evaluateVersionGate({
      current: '2.30.0',
      minimum: '2.44.0',
    })
    expect(message).toContain('2.30.0')
    expect(message).toContain('2.44.0')
    expect(message).toContain('at least')
  })

  test('blocks a build newer than requiredMaximumVersion', () => {
    const message = evaluateVersionGate({
      current: '2.50.0',
      maximum: '2.44.0',
    })
    expect(message).toContain('at most')
    expect(message).toContain('2.44.0')
  })

  test('no keys set means no gate', () => {
    expect(evaluateVersionGate({ current: '2.44.0' })).toBeNull()
  })

  test('fails open on unparseable policy values', () => {
    // A typo in a policy file must not lock a whole fleet out of its tooling.
    for (const bad of ['', 'latest', 'v2', '2.44', 'not-a-version']) {
      expect(
        evaluateVersionGate({ current: '2.44.0', minimum: bad }),
      ).toBeNull()
      expect(
        evaluateVersionGate({ current: '2.44.0', maximum: bad }),
      ).toBeNull()
    }
  })

  test('fails open when the running version is unparseable', () => {
    expect(
      evaluateVersionGate({ current: 'dev', minimum: '2.44.0' }),
    ).toBeNull()
  })

  test('minimum is reported before maximum when both fail', () => {
    // Impossible range in a policy file: report the "update" side, which is
    // the actionable one.
    expect(
      evaluateVersionGate({
        current: '2.44.0',
        minimum: '3.0.0',
        maximum: '2.0.0',
      }),
    ).toContain('at least')
  })
})
