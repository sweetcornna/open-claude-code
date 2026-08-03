import { describe, expect, test } from 'bun:test'
import { _test } from '../useInputBuffer.js'

function push(
  state: typeof _test.initialState,
  text: string,
): typeof _test.initialState {
  return _test.inputBufferReducer(state, {
    type: 'push',
    entry: {
      text,
      cursorOffset: text.length,
      pastedContents: {},
      timestamp: 1,
    },
    maxBufferSize: 10,
  })
}

describe('useInputBuffer history state', () => {
  test('does not advance the undo index for duplicate snapshots', () => {
    const first = push(_test.initialState, 'first')
    const duplicate = push(first, 'first')
    const second = push(duplicate, 'second')
    const undone = _test.inputBufferReducer(second, { type: 'undo' })

    expect(duplicate).toBe(first)
    expect(second.currentIndex).toBe(1)
    expect(undone.currentIndex).toBe(0)
    expect(undone.buffer[undone.currentIndex]?.text).toBe('first')
  })
})
