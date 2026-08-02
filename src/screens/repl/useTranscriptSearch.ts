import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- / n N Esc [ v are bare letters in transcript modal context, same class as g/G/j/k in ScrollKeybindingHandler
import { useInput, useSearchHighlight } from '@anthropic/ink'
import { writeFile } from 'fs/promises'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { JumpHandle } from '../../components/VirtualMessageList.js'
import { renderMessagesToPlainText } from '../../utils/exportRenderer.js'
import { openFileInExternalEditor } from '../../utils/editor.js'
import {
  generateTempFilePath,
  TRANSCRIPT_TEMP_PREFIX,
} from '../../utils/tempfile.js'
import type { Message as MessageType } from '../../types/message.js'
import type { Screen } from './types.js'

export type TranscriptSearchOpts = {
  screen: Screen
  virtualScrollActive: boolean
  dumpMode: boolean
  setDumpMode: React.Dispatch<React.SetStateAction<boolean>>
  setShowAllInTranscript: React.Dispatch<React.SetStateAction<boolean>>
  handleExitTranscript: () => void
  /** v-for-editor bookkeeping. Owned by REPL (the dump-mode footer reads
   *  editorStatus), passed in rather than moved: it is not search state, it
   *  just happens to be reset by the same transcript-exit effect. */
  editorRenderingRef: React.MutableRefObject<boolean>
  editorGenRef: React.MutableRefObject<number>
  editorTimerRef: React.MutableRefObject<
    ReturnType<typeof setTimeout> | undefined
  >
  setEditorStatus: React.Dispatch<React.SetStateAction<string>>
  deferredMessages: MessageType[]
  tools: Parameters<typeof renderMessagesToPlainText>[1]
}

/**
 * The transcript `less`-style search + pager cluster, lifted verbatim out of
 * REPL.tsx and called from the exact position the block used to occupy so the
 * hook call order is unchanged.
 *
 * Covers: search state, the two bare-letter `useInput` handlers (/ n N, and
 * q [ v), the search-highlight overlay, the resize-aborts-search effect and
 * the fresh-per-entry reset effect.
 */
export function useTranscriptSearch({
  screen,
  virtualScrollActive,
  dumpMode,
  setDumpMode,
  setShowAllInTranscript,
  handleExitTranscript,
  editorRenderingRef,
  editorGenRef,
  editorTimerRef,
  setEditorStatus,
  deferredMessages,
  tools,
}: TranscriptSearchOpts) {
  // Transcript search state. Hooks must be unconditional so they live here
  // (not inside the `if (screen === 'transcript')` branch below); isActive
  // gates the useInput. Query persists across bar open/close so n/N keep
  // working after Enter dismisses the bar (less semantics).
  const jumpRef = useRef<JumpHandle | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCount, setSearchCount] = useState(0)
  const [searchCurrent, setSearchCurrent] = useState(0)
  const onSearchMatchesChange = useCallback(
    (count: number, current: number) => {
      setSearchCount(count)
      setSearchCurrent(current)
    },
    [],
  )

  useInput(
    (input, key, event) => {
      if (key.ctrl || key.meta) return
      // No Esc handling here — less has no navigating mode. Search state
      // (highlights, n/N) is just state. Esc/q/ctrl+c → transcript:exit
      // (ungated). Highlights clear on exit via the screen-change effect.
      if (input === '/') {
        // Capture scrollTop NOW — typing is a preview, 0-matches snaps
        // back here. Synchronous ref write, fires before the bar's
        // mount-effect calls setSearchQuery.
        jumpRef.current?.setAnchor()
        setSearchOpen(true)
        event.stopImmediatePropagation()
        return
      }
      // Held-key batching: tokenizer coalesces to 'nnn'. Same uniform-batch
      // pattern as modalPagerAction in ScrollKeybindingHandler.tsx. Each
      // repeat is a step (n isn't idempotent like g).
      const c = input[0]
      if (
        (c === 'n' || c === 'N') &&
        input === c.repeat(input.length) &&
        searchCount > 0
      ) {
        const fn =
          c === 'n' ? jumpRef.current?.nextMatch : jumpRef.current?.prevMatch
        if (fn) for (let i = 0; i < input.length; i++) fn()
        event.stopImmediatePropagation()
      }
    },
    // Search needs virtual scroll (jumpRef drives VirtualMessageList). [
    // kills it, so !dumpMode — after [ there's nothing to jump in.
    {
      isActive:
        screen === 'transcript' &&
        virtualScrollActive &&
        !searchOpen &&
        !dumpMode,
    },
  )
  const {
    setQuery: setHighlight,
    scanElement,
    setPositions,
  } = useSearchHighlight()

  // Resize → abort search. Positions are (msg, query, WIDTH)-keyed —
  // cached positions are stale after a width change (new layout, new
  // wrapping). Clearing searchQuery triggers VML's setSearchQuery('')
  // which clears positionsCache + setPositions(null). Bar closes.
  // User hits / again → fresh everything.
  const transcriptCols = useTerminalSize().columns
  const prevColsRef = React.useRef(transcriptCols)
  React.useEffect(() => {
    if (prevColsRef.current !== transcriptCols) {
      prevColsRef.current = transcriptCols
      if (searchQuery || searchOpen) {
        setSearchOpen(false)
        setSearchQuery('')
        setSearchCount(0)
        setSearchCurrent(0)
        jumpRef.current?.disarmSearch()
        setHighlight('')
      }
    }
  }, [transcriptCols, searchQuery, searchOpen, setHighlight])

  // Transcript escape hatches. Bare letters in modal context (no prompt
  // competing for input) — same class as g/G/j/k in ScrollKeybindingHandler.
  useInput(
    (input, key, event) => {
      if (key.ctrl || key.meta) return
      if (input === 'q') {
        // less: q quits the pager. ctrl+o toggles; q is the lineage exit.
        handleExitTranscript()
        event.stopImmediatePropagation()
        return
      }
      if (input === '[' && !dumpMode) {
        // Force dump-to-scrollback. Also expand + uncap — no point dumping
        // a subset. Terminal/tmux cmd-F can now find anything. Guard here
        // (not in isActive) so v still works post-[ — dump-mode footer at
        // ~4898 wires editorStatus, confirming v is meant to stay live.
        setDumpMode(true)
        setShowAllInTranscript(true)
        event.stopImmediatePropagation()
      } else if (input === 'v') {
        // less-style: v opens the file in $VISUAL/$EDITOR. Render the full
        // transcript (same path /export uses), write to tmp, hand off.
        // openFileInExternalEditor handles alt-screen suspend/resume for
        // terminal editors; GUI editors spawn detached.
        event.stopImmediatePropagation()
        // Drop double-taps: the render is async and a second press before it
        // completes would run a second parallel render (double memory, two
        // tempfiles, two editor spawns). editorGenRef only guards
        // transcript-exit staleness, not same-session concurrency.
        if (editorRenderingRef.current) return
        editorRenderingRef.current = true
        // Capture generation + make a staleness-aware setter. Each write
        // checks gen (transcript exit bumps it → late writes from the
        // async render go silent).
        const gen = editorGenRef.current
        const setStatus = (s: string): void => {
          if (gen !== editorGenRef.current) return
          clearTimeout(editorTimerRef.current)
          setEditorStatus(s)
        }
        setStatus(`rendering ${deferredMessages.length} messages…`)
        void (async () => {
          try {
            // Width = terminal minus vim's line-number gutter (4 digits +
            // space + slack). Floor at 80. PassThrough has no .columns so
            // without this Ink defaults to 80. Trailing-space strip: right-
            // aligned timestamps still leave a flexbox spacer run at EOL.
            // eslint-disable-next-line custom-rules/prefer-use-terminal-size -- one-shot at keypress time, not a reactive render dep
            const w = Math.max(80, (process.stdout.columns ?? 80) - 6)
            const raw = await renderMessagesToPlainText(
              deferredMessages,
              tools,
              w,
            )
            const text = raw.replace(/[ \t]+$/gm, '')
            const path = generateTempFilePath(TRANSCRIPT_TEMP_PREFIX, '.txt')
            await writeFile(path, text)
            const opened = openFileInExternalEditor(path)
            setStatus(
              opened
                ? `opening ${path}`
                : `wrote ${path} · no $VISUAL/$EDITOR set`,
            )
          } catch (e) {
            setStatus(
              `render failed: ${e instanceof Error ? e.message : String(e)}`,
            )
          }
          editorRenderingRef.current = false
          if (gen !== editorGenRef.current) return
          editorTimerRef.current = setTimeout(s => s(''), 4000, setEditorStatus)
        })()
      }
    },
    // !searchOpen: typing 'v' or '[' in the search bar is search input, not
    // a command. No !dumpMode here — v should work after [ (the [ handler
    // guards itself inline).
    { isActive: screen === 'transcript' && virtualScrollActive && !searchOpen },
  )

  // Fresh `less` per transcript entry. Prevents stale highlights matching
  // unrelated normal-mode text (overlay is alt-screen-global) and avoids
  // surprise n/N on re-entry. Same exit resets [ dump mode — each ctrl+o
  // entry is a fresh instance.
  const inTranscript = screen === 'transcript' && virtualScrollActive
  useEffect(() => {
    if (!inTranscript) {
      setSearchQuery('')
      setSearchCount(0)
      setSearchCurrent(0)
      setSearchOpen(false)
      editorGenRef.current++
      clearTimeout(editorTimerRef.current)
      setDumpMode(false)
      setEditorStatus('')
    }
  }, [inTranscript])
  useEffect(() => {
    setHighlight(inTranscript ? searchQuery : '')
    // Clear the position-based CURRENT (yellow) overlay too. setHighlight
    // only clears the scan-based inverse. Without this, the yellow box
    // persists at its last screen coords after ctrl-c exits transcript.
    if (!inTranscript) setPositions(null)
  }, [inTranscript, searchQuery, setHighlight, setPositions])
  return {
    jumpRef,
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchCount,
    setSearchCount,
    searchCurrent,
    setSearchCurrent,
    onSearchMatchesChange,
    setHighlight,
    scanElement,
    setPositions,
    transcriptCols,
  }
}
