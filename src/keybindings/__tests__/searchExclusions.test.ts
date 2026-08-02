import { describe, expect, test } from 'bun:test'
import { parseBindings } from '../parser.js'
import { derivePlainCharExclusions } from '../searchExclusions.js'

const SETTINGS_ACTIONS = [
  'select:previous',
  'select:next',
  'select:accept',
  'settings:search',
]

const DEFAULT_BLOCKS = [
  {
    context: 'Settings',
    bindings: {
      up: 'select:previous',
      down: 'select:next',
      k: 'select:previous',
      j: 'select:next',
      'ctrl+p': 'select:previous',
      'ctrl+n': 'select:next',
      space: 'select:accept',
      '/': 'settings:search',
      r: 'settings:retry',
    },
  },
]

describe('derivePlainCharExclusions', () => {
  test('derives the default carve-out from bound actions', () => {
    const bindings = parseBindings(DEFAULT_BLOCKS)
    const excluded = derivePlainCharExclusions(
      bindings,
      ['Settings', 'Global'],
      SETTINGS_ACTIONS,
    )
    // j/k// and space are bound to handled actions; multi-char key names
    // (up/down) and modifier combos (ctrl+p/n) are never candidates.
    expect([...excluded].sort()).toEqual(['/', 'j', 'k', ' '].sort())
  })

  test('keys bound to unhandled actions are not excluded', () => {
    const bindings = parseBindings(DEFAULT_BLOCKS)
    const excluded = derivePlainCharExclusions(
      bindings,
      ['Settings', 'Global'],
      SETTINGS_ACTIONS,
    )
    // 'r' is bound to settings:retry, which this panel does not handle —
    // it must keep typing into the search box.
    expect(excluded.has('r')).toBe(false)
  })

  test('user override remapping a key to an unhandled action lifts the exclusion', () => {
    const bindings = parseBindings([
      ...DEFAULT_BLOCKS,
      // User bindings load after defaults; resolver semantics are
      // last-match-wins, so the remap shadows the vim-nav default.
      { context: 'Settings', bindings: { j: 'settings:retry' } },
    ])
    const excluded = derivePlainCharExclusions(
      bindings,
      ['Settings', 'Global'],
      SETTINGS_ACTIONS,
    )
    expect(excluded.has('j')).toBe(false)
    expect(excluded.has('k')).toBe(true)
  })

  test('user override binding a new key to a handled action adds the exclusion', () => {
    const bindings = parseBindings([
      ...DEFAULT_BLOCKS,
      { context: 'Settings', bindings: { n: 'select:next' } },
    ])
    const excluded = derivePlainCharExclusions(
      bindings,
      ['Settings', 'Global'],
      SETTINGS_ACTIONS,
    )
    expect(excluded.has('n')).toBe(true)
  })

  test('unbinding (action: null) lifts the exclusion', () => {
    const bindings = parseBindings([
      ...DEFAULT_BLOCKS,
      { context: 'Settings', bindings: { j: null } },
    ])
    const excluded = derivePlainCharExclusions(
      bindings,
      ['Settings', 'Global'],
      SETTINGS_ACTIONS,
    )
    expect(excluded.has('j')).toBe(false)
  })

  test('bindings from other contexts are ignored', () => {
    const bindings = parseBindings([
      ...DEFAULT_BLOCKS,
      { context: 'Chat', bindings: { x: 'select:next' } },
    ])
    const excluded = derivePlainCharExclusions(
      bindings,
      ['Settings', 'Global'],
      SETTINGS_ACTIONS,
    )
    expect(excluded.has('x')).toBe(false)
  })
})
