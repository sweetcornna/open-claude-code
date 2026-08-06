/**
 * Tests for the guarded back-navigation.
 *
 * The rule is about a keypress, not about state: a handler belonging to a screen
 * that is no longer displayed must *decline* the key (return `false`) rather
 * than quietly do nothing. `useKeybinding` stops propagation for any handler
 * that does not return `false`, so "quietly do nothing" and "swallow the key"
 * are the same thing — which is how Esc ended up dead on the model step, and how
 * it walked back two screens before that.
 */
import { describe, expect, test } from 'bun:test'
import { backFromScreen } from '../backNavigation.js'

type Screen = { state: string }

function ref(current: Screen | null): { current: Screen | null } {
  return { current }
}

describe('backFromScreen', () => {
  test('navigates when its screen is the one on display', () => {
    const seen: Screen[] = []
    const result = backFromScreen(
      ref({ state: 'provider_model_setup' }),
      to => seen.push(to),
      'provider_model_setup',
      { state: 'china_apikey' },
    )

    expect(seen).toEqual([{ state: 'china_apikey' }])
    // Not `false`: the key was consumed, propagation should stop here.
    expect(result).toBeUndefined()
  })

  test('declines the keypress when its screen is stale', () => {
    // The previous screen's handler is still registered and runs first. It must
    // hand the key on, or the screen that IS current never sees it.
    const seen: Screen[] = []
    const result = backFromScreen(
      ref({ state: 'provider_model_setup' }),
      to => seen.push(to),
      'china_apikey',
      { state: 'china_provider_select' },
    )

    expect(seen).toEqual([])
    expect(result).toBe(false)
  })

  test('declines rather than throwing when there is no live screen', () => {
    const seen: Screen[] = []
    expect(
      backFromScreen(ref(null), to => seen.push(to), 'china_apikey', {
        state: 'china_provider_select',
      }),
    ).toBe(false)
    expect(seen).toEqual([])
  })

  test('two stacked handlers move exactly one screen', () => {
    // The scenario that produced the bug: Esc on the model step reaches the
    // stale key-screen handler first, then the model step's own.
    let live: Screen = { state: 'provider_model_setup' }
    const liveRef = {
      get current() {
        return live
      },
    }
    const navigate = (to: Screen): void => {
      live = to
    }

    // Registered earlier, belongs to the screen underneath.
    const stale = backFromScreen(liveRef, navigate, 'china_apikey', {
      state: 'china_provider_select',
    })
    expect(stale).toBe(false)
    expect(live).toEqual({ state: 'provider_model_setup' })

    // The current screen's handler then gets the key.
    const current = backFromScreen(liveRef, navigate, 'provider_model_setup', {
      state: 'china_apikey',
    })
    expect(current).toBeUndefined()
    expect(live).toEqual({ state: 'china_apikey' })
  })
})
