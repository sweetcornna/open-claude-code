import { afterEach, describe, expect, test } from 'bun:test'
import type { TerminalQuerier } from '../../core/terminal-querier.js'
import {
  getSystemThemeName,
  resetCachedSystemThemeForTesting,
} from '../systemTheme.js'
import { watchSystemTheme } from '../../../utils/systemThemeWatcher.js'

afterEach(() => resetCachedSystemThemeForTesting())

/** Stand-in for TerminalQuerier: replays scripted OSC 11 replies. */
function fakeQuerier(replies: Array<string | undefined>) {
  let calls = 0
  const querier = {
    send: async () => {
      const data = replies[Math.min(calls, replies.length - 1)]
      calls++
      return data === undefined ? undefined : { type: 'osc', code: 11, data }
    },
    flush: async () => {},
  } as unknown as TerminalQuerier
  return { querier, sendCount: () => calls }
}

/** Let the watcher's immediate poll settle (it awaits two microtask hops). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
}

describe('watchSystemTheme', () => {
  test('reports the terminal background on the first poll', async () => {
    // Fires immediately rather than after a full interval — otherwise
    // switching to 'auto' shows the wrong palette until the first tick.
    const { querier } = fakeQuerier(['rgb:ffff/ffff/ffff'])
    const seen: string[] = []
    const stop = watchSystemTheme(querier, t => void seen.push(t as string))
    await settle()
    stop()
    expect(seen).toEqual(['light'])
  })

  test('updates the module cache so synchronous resolvers agree', async () => {
    // resolveThemeSetting() resolves 'auto' without awaiting the OSC probe.
    // If the watcher only pushed React state, that path would keep answering
    // with the stale seed.
    resetCachedSystemThemeForTesting()
    const { querier } = fakeQuerier(['rgb:ffff/ffff/ffff'])
    const stop = watchSystemTheme(querier, () => {})
    await settle()
    stop()
    expect(getSystemThemeName()).toBe('light')
  })

  test('stops polling a terminal that ignores OSC 11', async () => {
    // No reply means unsupported, and that will not change mid-session.
    // Re-querying forever would spend a round-trip every interval for nothing.
    const { querier, sendCount } = fakeQuerier([undefined])
    const seen: string[] = []
    const stop = watchSystemTheme(querier, t => void seen.push(t as string))
    await settle()
    const afterFirst = sendCount()
    await new Promise(r => setTimeout(r, 60))
    stop()
    expect(seen).toEqual([])
    expect(sendCount()).toBe(afterFirst)
  })

  test('keeps the previous theme when a reply is unparseable', async () => {
    const { querier } = fakeQuerier(['garbage'])
    const seen: string[] = []
    const stop = watchSystemTheme(querier, t => void seen.push(t as string))
    await settle()
    stop()
    // No update at all beats flipping the whole palette on a malformed reply.
    expect(seen).toEqual([])
  })

  test('stop() is idempotent and silences later updates', async () => {
    const { querier } = fakeQuerier(['rgb:0000/0000/0000'])
    const seen: string[] = []
    const stop = watchSystemTheme(querier, t => void seen.push(t as string))
    stop()
    stop()
    await settle()
    expect(seen).toEqual([])
  })

  test('survives a querier that throws', async () => {
    // A terminal quirk must not take down the render tree.
    const querier = {
      send: async () => {
        throw new Error('stdin closed')
      },
      flush: async () => {},
    } as unknown as TerminalQuerier
    const stop = watchSystemTheme(querier, () => {})
    await settle()
    expect(() => stop()).not.toThrow()
  })
})
