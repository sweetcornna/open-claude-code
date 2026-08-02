/**
 * Tests for the TaskDetail context (S8 keybinding migration).
 *
 * The background-task detail dialogs (shell / async agent / in-process
 * teammate / dream / monitor-mcp) used to hard-code `x` = kill and `f` =
 * foreground in a raw onKeyDown handler, so users could not rebind them —
 * `x` in particular is destructive. They now resolve through the named
 * TaskDetail context.
 *
 * What these tests pin:
 *  1. The default keys are unchanged (x / f) — migration must be invisible.
 *  2. A user override actually takes effect (the whole point of migrating).
 *  3. x/f do NOT leak into contexts where they are ordinary typed characters.
 */
import { describe, expect, test } from 'bun:test'
import type { Key } from '@anthropic/ink'
import { resolveKey } from '@anthropic/ink'
import { DEFAULT_BINDINGS } from '../defaultBindings.js'
import { parseBindings } from '../parser.js'

function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    wheelUp: false,
    wheelDown: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    fn: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    ...overrides,
  }
}

const bindings = parseBindings(DEFAULT_BINDINGS)

describe('TaskDetail default bindings (behaviour must match the old raw handlers)', () => {
  test('"x" resolves to taskDetail:kill', () => {
    expect(resolveKey('x', makeKey(), ['TaskDetail'], bindings)).toEqual({
      type: 'match',
      action: 'taskDetail:kill',
    })
  })

  test('"f" resolves to taskDetail:foreground', () => {
    expect(resolveKey('f', makeKey(), ['TaskDetail'], bindings)).toEqual({
      type: 'match',
      action: 'taskDetail:foreground',
    })
  })

  test('still resolves when Confirmation is active alongside (the real dialog setup)', () => {
    // Each dialog registers confirm:yes in Confirmation *and* the kill handler
    // in TaskDetail, so both contexts are live at once. Neither may shadow the
    // other: Confirmation binds enter/escape, TaskDetail binds x/f.
    const contexts = ['Confirmation', 'TaskDetail']
    expect(resolveKey('x', makeKey(), contexts, bindings)).toEqual({
      type: 'match',
      action: 'taskDetail:kill',
    })
    expect(
      resolveKey('', makeKey({ return: true }), contexts, bindings),
    ).toEqual({
      type: 'match',
      action: 'confirm:yes',
    })
  })
})

describe('TaskDetail bindings do not leak into typing contexts', () => {
  for (const context of ['Chat', 'Settings', 'Select']) {
    test(`"x" is not taskDetail:kill in ${context}`, () => {
      const result = resolveKey('x', makeKey(), [context], bindings)
      if (result.type === 'match') {
        expect(result.action).not.toBe('taskDetail:kill')
      }
    })
  }
})

describe('TaskDetail bindings are user-overridable', () => {
  // Overrides append after the defaults; resolveKey takes the last match.
  test('rebinding taskDetail:kill to ctrl+k takes effect', () => {
    const overridden = parseBindings([
      ...DEFAULT_BINDINGS,
      { context: 'TaskDetail', bindings: { 'ctrl+k': 'taskDetail:kill' } },
    ])
    expect(
      resolveKey('k', makeKey({ ctrl: true }), ['TaskDetail'], overridden),
    ).toEqual({ type: 'match', action: 'taskDetail:kill' })
  })

  test('unbinding "x" with null disables the destructive default', () => {
    const overridden = parseBindings([
      ...DEFAULT_BINDINGS,
      { context: 'TaskDetail', bindings: { x: null } },
    ])
    expect(resolveKey('x', makeKey(), ['TaskDetail'], overridden)).toEqual({
      type: 'unbound',
    })
  })
})
