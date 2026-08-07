import { beforeEach, describe, expect, test } from 'bun:test'
import {
  registerTerminalPoll,
  stopTerminalPolls,
} from '../../../utils/terminalPollRegistry.js'
import { oscColor, TerminalQuerier } from '../terminal-querier.js'

/**
 * Regression tests for the escape sequences that leaked into the shell after
 * Ctrl+C (`^[]11;rgb:…` and `^[[?62;22;52c`).
 *
 * The leak had two independent enablers: a 3s OSC 11 poll with no shutdown
 * hook, and a querier that wrote its request bytes regardless of whether
 * anything could answer them. Both are covered here. The end-to-end symptom
 * (bytes surviving into the parent shell) cannot be asserted from a unit test
 * — that needs a real terminal.
 */

type Written = { data: string[]; isTTY?: boolean }

function fakeStdout(isTTY?: boolean): Written & { write(s: string): void } {
  const data: string[] = []
  return {
    data,
    isTTY,
    write(s: string) {
      data.push(s)
    },
  }
}

describe('terminal poll registry', () => {
  beforeEach(() => stopTerminalPolls())

  test('stops every registered poll', () => {
    let a = 0
    let b = 0
    registerTerminalPoll(() => a++)
    registerTerminalPoll(() => b++)

    stopTerminalPolls()

    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  test('is idempotent — shutdown calls it from more than one path', () => {
    let stops = 0
    registerTerminalPoll(() => stops++)

    stopTerminalPolls()
    stopTerminalPolls()
    stopTerminalPolls()

    // gracefulShutdown and Ink.unmount both call it; the second must be a
    // no-op rather than re-running a stop on an already-cleared timer.
    expect(stops).toBe(1)
  })

  test('a throwing poll does not block the others or shutdown', () => {
    let reached = 0
    registerTerminalPoll(() => {
      throw new Error('boom')
    })
    registerTerminalPoll(() => reached++)

    expect(() => stopTerminalPolls()).not.toThrow()
    expect(reached).toBe(1)
  })

  test('unregister removes the poll so a stopped watcher is not re-stopped', () => {
    let stops = 0
    const unregister = registerTerminalPoll(() => stops++)

    unregister()
    stopTerminalPolls()

    expect(stops).toBe(0)
  })
})

describe('TerminalQuerier TTY guard', () => {
  test('writes nothing when stdout is not a TTY', async () => {
    const stdout = fakeStdout(false)
    const querier = new TerminalQuerier(stdout as never)

    // Without the guard these wrote `\x1b]11;?\x07` and `\x1b[c` into whatever
    // was consuming stdout — a pipe, a file, or a CI log.
    const response = await querier.send(oscColor(11))
    await querier.flush()

    expect(stdout.data).toEqual([])
    // Same answer a terminal that ignores the query gives, so callers need no
    // extra branch.
    expect(response).toBeUndefined()
  })

  test('still writes when stdout is a TTY', () => {
    const stdout = fakeStdout(true)
    const querier = new TerminalQuerier(stdout as never)

    void querier.send(oscColor(11))
    void querier.flush()

    expect(stdout.data.length).toBe(2)
    expect(stdout.data[0]).toContain('11;?')
  })

  test('treats an absent isTTY as writable so test doubles still exercise the queue', () => {
    const stdout = fakeStdout(undefined)
    const querier = new TerminalQuerier(stdout as never)

    void querier.send(oscColor(11))

    expect(stdout.data.length).toBe(1)
  })
})
