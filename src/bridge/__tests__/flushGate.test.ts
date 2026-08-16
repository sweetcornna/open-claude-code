import { describe, expect, test } from 'bun:test'
import { FlushGate } from '../flushGate.js'

describe('FlushGate', () => {
  test('passes writes through when inactive', () => {
    const gate = new FlushGate<string>()
    expect(gate.active).toBe(false)
    expect(gate.enqueue('a')).toBe(false)
    expect(gate.pendingCount).toBe(0)
  })

  test('queues while active and hands everything back in order', () => {
    const gate = new FlushGate<string>()
    gate.start()
    expect(gate.enqueue('a', 'b')).toBe(true)
    expect(gate.enqueue('c')).toBe(true)
    expect(gate.pendingCount).toBe(3)

    expect(gate.end()).toEqual(['a', 'b', 'c'])
    expect(gate.active).toBe(false)
    expect(gate.pendingCount).toBe(0)
  })

  test('drop discards and reports the count', () => {
    const gate = new FlushGate<string>()
    gate.start()
    gate.enqueue('a', 'b')
    expect(gate.drop()).toBe(2)
    expect(gate.active).toBe(false)
    expect(gate.pendingCount).toBe(0)
  })

  // The property the outbound hold depends on: re-starting an already-active
  // gate must extend the hold across a second transport swap rather than
  // resetting it. A close during a rotation used to be the case where the
  // first batch silently vanished.
  test('start() on an active gate keeps what is already queued', () => {
    const gate = new FlushGate<string>()
    gate.start()
    gate.enqueue('during-rotation')
    gate.start()
    gate.enqueue('during-close')
    expect(gate.end()).toEqual(['during-rotation', 'during-close'])
  })

  test('start() after end() begins a fresh hold', () => {
    const gate = new FlushGate<string>()
    gate.start()
    gate.enqueue('first')
    expect(gate.end()).toEqual(['first'])
    gate.start()
    gate.enqueue('second')
    expect(gate.end()).toEqual(['second'])
  })

  test('end() on an empty gate just clears the flag', () => {
    const gate = new FlushGate<string>()
    gate.start()
    expect(gate.end()).toEqual([])
    expect(gate.active).toBe(false)
  })
})
