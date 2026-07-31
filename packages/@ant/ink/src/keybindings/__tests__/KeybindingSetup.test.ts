import { describe, expect, test } from 'bun:test'
import { InputEvent } from '../../core/events/input-event.js'
import type { Key } from '../../core/events/input-event.js'
import {
  type ChordInterceptorDeps,
  type HandlerRegistration,
  interceptChordInput,
} from '../KeybindingSetup.js'
import type { ParsedBinding, ParsedKeystroke } from '../types.js'

function keystroke(
  key: string,
  modifiers: Partial<Omit<ParsedKeystroke, 'key'>> = {},
): ParsedKeystroke {
  return {
    key,
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    super: false,
    ...modifiers,
  }
}

function inkKey(modifiers: Partial<Key> = {}): Key {
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
    ...modifiers,
  }
}

function makeEvent(name: string): InputEvent {
  return new InputEvent({
    kind: 'key',
    name,
    fn: false,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: name,
    raw: name,
    isPasted: false,
  })
}

// "ctrl+x k" -> chord:action, plus a standalone "k" -> single:action that the
// chord completion must not fall through to.
const CHORD_ACTION = 'chord:action'
const SINGLE_ACTION = 'single:action'

const BINDINGS: ParsedBinding[] = [
  {
    chord: [keystroke('x', { ctrl: true }), keystroke('k')],
    action: CHORD_ACTION,
    context: 'Global',
  },
  { chord: [keystroke('k')], action: SINGLE_ACTION, context: 'Global' },
]

type Harness = {
  deps: ChordInterceptorDeps
  pending: () => ParsedKeystroke[] | null
}

function makeHarness(registry: Map<string, Set<HandlerRegistration>>): Harness {
  const pendingChordRef: { current: ParsedKeystroke[] | null } = {
    current: null,
  }

  return {
    deps: {
      bindings: BINDINGS,
      pendingChordRef,
      setPendingChord: pending => {
        pendingChordRef.current = pending
      },
      activeContexts: new Set(['Global']),
      handlerRegistryRef: { current: registry },
    },
    pending: () => pendingChordRef.current,
  }
}

/** Send `ctrl+x` then `k`, returning the event for the completing keystroke. */
function completeChord(harness: Harness): InputEvent {
  const prefixEvent = makeEvent('x')
  interceptChordInput('x', inkKey({ ctrl: true }), prefixEvent, harness.deps)
  expect(harness.pending()).not.toBeNull()

  const finalEvent = makeEvent('k')
  interceptChordInput('k', inkKey(), finalEvent, harness.deps)

  return finalEvent
}

describe('interceptChordInput chord completion', () => {
  test('consumes the completing key when no handler is registered', () => {
    const harness = makeHarness(new Map())

    const event = completeChord(harness)

    expect(event.didStopImmediatePropagation()).toBe(true)
    expect(harness.pending()).toBeNull()
  })

  test('consumes the completing key when the registry has no handler for the action', () => {
    let singleActionCalls = 0
    const registry = new Map<string, Set<HandlerRegistration>>([
      [
        SINGLE_ACTION,
        new Set([
          {
            action: SINGLE_ACTION,
            context: 'Global',
            handler: () => {
              singleActionCalls++
            },
          },
        ]),
      ],
    ])
    const harness = makeHarness(registry)

    const event = completeChord(harness)

    expect(event.didStopImmediatePropagation()).toBe(true)
    // The chord completion must not leak through to the standalone "k" binding.
    expect(singleActionCalls).toBe(0)
  })

  test('consumes the completing key when the action has an empty handler set', () => {
    const registry = new Map<string, Set<HandlerRegistration>>([
      [CHORD_ACTION, new Set<HandlerRegistration>()],
    ])
    const harness = makeHarness(registry)

    const event = completeChord(harness)

    expect(event.didStopImmediatePropagation()).toBe(true)
  })

  test('invokes the registered handler and still consumes the key', () => {
    let calls = 0
    const registry = new Map<string, Set<HandlerRegistration>>([
      [
        CHORD_ACTION,
        new Set([
          {
            action: CHORD_ACTION,
            context: 'Global',
            handler: () => {
              calls++
            },
          },
        ]),
      ],
    ])
    const harness = makeHarness(registry)

    const event = completeChord(harness)

    expect(calls).toBe(1)
    expect(event.didStopImmediatePropagation()).toBe(true)
  })

  test('lets a plain single-key match propagate to per-hook handlers', () => {
    const harness = makeHarness(new Map())

    const event = makeEvent('k')
    interceptChordInput('k', inkKey(), event, harness.deps)

    expect(event.didStopImmediatePropagation()).toBe(false)
    expect(harness.pending()).toBeNull()
  })

  test('consumes the chord prefix key', () => {
    const harness = makeHarness(new Map())

    const event = makeEvent('x')
    interceptChordInput('x', inkKey({ ctrl: true }), event, harness.deps)

    expect(event.didStopImmediatePropagation()).toBe(true)
    expect(harness.pending()).toEqual([keystroke('x', { ctrl: true })])
  })

  test('consumes a cancelled chord', () => {
    const harness = makeHarness(new Map())

    const prefixEvent = makeEvent('x')
    interceptChordInput('x', inkKey({ ctrl: true }), prefixEvent, harness.deps)

    const cancelEvent = makeEvent('z')
    interceptChordInput('z', inkKey(), cancelEvent, harness.deps)

    expect(cancelEvent.didStopImmediatePropagation()).toBe(true)
    expect(harness.pending()).toBeNull()
  })
})
