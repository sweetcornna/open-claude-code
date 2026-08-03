import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { PastedContent } from '../utils/config/config.js'

export type BufferEntry = {
  text: string
  cursorOffset: number
  pastedContents: Record<number, PastedContent>
  timestamp: number
}

export type UseInputBufferProps = {
  maxBufferSize: number
  debounceMs: number
}

export type UseInputBufferResult = {
  pushToBuffer: (
    text: string,
    cursorOffset: number,
    pastedContents?: Record<number, PastedContent>,
  ) => void
  undo: () => BufferEntry | undefined
  canUndo: boolean
  clearBuffer: () => void
}

type InputBufferState = {
  buffer: BufferEntry[]
  currentIndex: number
}

type InputBufferAction =
  | { type: 'push'; entry: BufferEntry; maxBufferSize: number }
  | { type: 'undo' }
  | { type: 'clear' }

const INITIAL_BUFFER_STATE: InputBufferState = {
  buffer: [],
  currentIndex: -1,
}

function inputBufferReducer(
  state: InputBufferState,
  action: InputBufferAction,
): InputBufferState {
  if (action.type === 'clear') return INITIAL_BUFFER_STATE

  if (action.type === 'undo') {
    if (state.currentIndex < 0 || state.buffer.length === 0) return state
    return {
      ...state,
      currentIndex: Math.max(0, state.currentIndex - 1),
    }
  }

  const truncatedBuffer =
    state.currentIndex >= 0
      ? state.buffer.slice(0, state.currentIndex + 1)
      : state.buffer
  const lastEntry = truncatedBuffer[truncatedBuffer.length - 1]

  // Index and snapshots form one state transition; duplicate text must leave
  // both unchanged or the next undo points at the current text again.
  if (lastEntry?.text === action.entry.text) return state

  if (action.maxBufferSize <= 0) return INITIAL_BUFFER_STATE

  const buffer = [...truncatedBuffer, action.entry].slice(-action.maxBufferSize)
  return { buffer, currentIndex: buffer.length - 1 }
}

export function useInputBuffer({
  maxBufferSize,
  debounceMs,
}: UseInputBufferProps): UseInputBufferResult {
  const [state, dispatch] = useReducer(inputBufferReducer, INITIAL_BUFFER_STATE)
  const lastPushTime = useRef<number>(0)
  const pendingPush = useRef<ReturnType<typeof setTimeout> | null>(null)

  const pushToBuffer = useCallback(
    (
      text: string,
      cursorOffset: number,
      pastedContents: Record<number, PastedContent> = {},
    ) => {
      const now = Date.now()

      // Clear any pending push
      if (pendingPush.current) {
        clearTimeout(pendingPush.current)
        pendingPush.current = null
      }

      // Debounce rapid changes
      if (now - lastPushTime.current < debounceMs) {
        pendingPush.current = setTimeout(
          pushToBuffer,
          debounceMs,
          text,
          cursorOffset,
          pastedContents,
        )
        return
      }

      lastPushTime.current = now
      dispatch({
        type: 'push',
        entry: { text, cursorOffset, pastedContents, timestamp: now },
        maxBufferSize,
      })
    },
    [debounceMs, maxBufferSize],
  )

  const undo = useCallback((): BufferEntry | undefined => {
    if (state.currentIndex < 0 || state.buffer.length === 0) {
      return undefined
    }

    const targetIndex = Math.max(0, state.currentIndex - 1)
    const entry = state.buffer[targetIndex]

    if (entry) {
      dispatch({ type: 'undo' })
      return entry
    }

    return undefined
  }, [state])

  const clearBuffer = useCallback(() => {
    dispatch({ type: 'clear' })
    lastPushTime.current = 0
    if (pendingPush.current) {
      clearTimeout(pendingPush.current)
      pendingPush.current = null
    }
  }, [])

  useEffect(
    () => () => {
      if (pendingPush.current) clearTimeout(pendingPush.current)
    },
    [],
  )

  const canUndo = state.currentIndex > 0 && state.buffer.length > 1

  return {
    pushToBuffer,
    undo,
    canUndo,
    clearBuffer,
  }
}

export const _test = {
  inputBufferReducer,
  initialState: INITIAL_BUFFER_STATE,
}
