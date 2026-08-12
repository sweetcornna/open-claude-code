/**
 * `occ agents` picks between two surfaces. No mocks: the predicate is pure and
 * the module it lives in imports cleanly.
 */
import { describe, expect, test } from 'bun:test'
import { shouldMountFleetView } from '../agents.js'

const TTY = { stdoutIsTTY: true, stdinIsTTY: true }

describe('shouldMountFleetView', () => {
  test('an interactive terminal with no flags gets FleetView', () => {
    expect(shouldMountFleetView({}, TTY)).toBe(true)
  })

  test('--list is an explicit opt-out even on a TTY', () => {
    // The old behaviour has to stay reachable: this is the whole reason the
    // flag exists rather than the command silently changing meaning.
    expect(shouldMountFleetView({ list: true }, TTY)).toBe(false)
  })

  test('a piped stdout falls back to the text dump', () => {
    // `occ agents | grep foo` and CI both land here.
    expect(
      shouldMountFleetView({}, { stdoutIsTTY: undefined, stdinIsTTY: true }),
    ).toBe(false)
  })

  test('a redirected stdin falls back too — nobody could drive the list', () => {
    expect(
      shouldMountFleetView({}, { stdoutIsTTY: true, stdinIsTTY: undefined }),
    ).toBe(false)
  })

  test('a fully non-interactive invocation falls back', () => {
    expect(shouldMountFleetView({}, {})).toBe(false)
  })
})
