import type { UUID } from 'crypto'
import { useEffect, useRef } from 'react'
import { useAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { isAgentSwarmsEnabled } from '../utils/agents/agentSwarmsEnabled.js'
import {
  cleanMessagesForLogging,
  isChainParticipant,
  recordTranscript,
} from '../utils/sessionStorage.js'

export type TranscriptWritePlan = {
  wasFirstRender: boolean
  isIncremental: boolean
  isSameHeadShrink: boolean
  /** Where the slice handed to recordTranscript starts. */
  startIndex: number
  /** Nothing new to write; the effect returns without touching the transcript. */
  skip: boolean
}

/**
 * Classify a render against the last one that was recorded. Pure, and split out
 * so the cases below can be pinned without a React renderer.
 *
 * `skip` covers in-place replacement: the array is the same length with the
 * same head, so no message is new. Two producers rely on that and both are
 * correct to write nothing:
 *
 *   - ephemeral progress ticks (bash chunks), which are not loggable at all;
 *   - compaction replaying `messagesToKeep` with `toolUseResult` stripped
 *     (see `upsertMessageByUuid`). The transcript already holds those uuids,
 *     with the payload the in-memory copy just dropped, and `recordTranscript`
 *     would skip them anyway.
 */
export function planTranscriptWrite(state: {
  length: number
  firstUuid: UUID | undefined
  recordedLength: number
  recordedFirstUuid: UUID | undefined
}): TranscriptWritePlan {
  // First-render: recordedFirstUuid is undefined. Compaction: first uuid changes.
  // Both are !isIncremental, but first-render sync-walk is safe (no messagesToKeep).
  const wasFirstRender = state.recordedFirstUuid === undefined
  const sameHead =
    state.firstUuid !== undefined &&
    !wasFirstRender &&
    state.firstUuid === state.recordedFirstUuid
  const isIncremental = sameHead && state.recordedLength <= state.length
  // Same-head shrink: tombstone filter, rewind, snip, partial-compact.
  // Distinguished from compaction (first uuid changes) because the tail
  // is either an existing on-disk message or a fresh message that this
  // same effect's recordTranscript(fullArray) will write — see sync-walk
  // guard in the hook below.
  const isSameHeadShrink = sameHead && state.recordedLength > state.length
  const startIndex = isIncremental ? state.recordedLength : 0
  return {
    wasFirstRender,
    isIncremental,
    isSameHeadShrink,
    startIndex,
    skip: startIndex === state.length,
  }
}

/**
 * Hook that logs messages to the transcript
 * conversation ID that only changes when a new conversation is started.
 *
 * @param messages The current conversation messages
 * @param ignore When true, messages will not be recorded to the transcript
 */
export function useLogMessages(messages: Message[], ignore: boolean = false) {
  const teamContext = useAppState(s => s.teamContext)

  // messages is append-only between compactions, so track where we left off
  // and only pass the new tail to recordTranscript. Avoids O(n) filter+scan
  // on every setMessages (~20x/turn, so n=3000 was ~120k wasted iterations).
  const lastRecordedLengthRef = useRef(0)
  const lastParentUuidRef = useRef<UUID | undefined>(undefined)
  // First-uuid change = compaction or /clear rebuilt the array; length alone
  // can't detect this since post-compact [CB,summary,...keep,new] may be longer.
  const firstMessageUuidRef = useRef<UUID | undefined>(undefined)
  // Guard against stale async .then() overwriting a fresher sync update when
  // an incremental render fires before the compaction .then() resolves.
  const callSeqRef = useRef(0)

  useEffect(() => {
    if (ignore) return

    const currentFirstUuid = messages[0]?.uuid as UUID | undefined
    const {
      wasFirstRender,
      isIncremental,
      isSameHeadShrink,
      startIndex,
      skip,
    } = planTranscriptWrite({
      length: messages.length,
      firstUuid: currentFirstUuid,
      recordedLength: lastRecordedLengthRef.current,
      recordedFirstUuid: firstMessageUuidRef.current,
    })
    if (skip) return

    // Full array on first call + after compaction: recordTranscript's own
    // O(n) dedup loop handles messagesToKeep interleaving correctly there.
    const slice = startIndex === 0 ? messages : messages.slice(startIndex)
    const parentHint = isIncremental ? lastParentUuidRef.current : undefined

    // Fire and forget - we don't want to block the UI.
    const seq = ++callSeqRef.current
    void recordTranscript(
      slice,
      isAgentSwarmsEnabled()
        ? {
            teamName: teamContext?.teamName,
            agentName: teamContext?.selfAgentName,
          }
        : {},
      parentHint,
      messages,
    ).then(lastRecordedUuid => {
      // For compaction/full array case (!isIncremental): use the async return
      // value. After compaction, messagesToKeep in the array are skipped
      // (already in transcript), so the sync loop would find a wrong UUID.
      // Skip if a newer effect already ran (stale closure would overwrite the
      // fresher sync update from the subsequent incremental render).
      if (seq !== callSeqRef.current) return
      if (lastRecordedUuid && !isIncremental) {
        lastParentUuidRef.current = lastRecordedUuid
      }
    })

    // Sync-walk safe for: incremental (pure new-tail slice), first-render
    // (no messagesToKeep interleaving), and same-head shrink. Shrink is the
    // subtle one: the picked uuid is either already on disk (tombstone/rewind
    // — survivors were written before) or is being written by THIS effect's
    // recordTranscript(fullArray) call (snip boundary / partial-compact tail
    // — enqueueWrite ordering guarantees it lands before any later write that
    // chains to it). Without this, the ref stays stale at a tombstoned uuid:
    // the async .then() correction is raced out by the next effect's seq bump
    // on large sessions where recordTranscript(fullArray) is slow. Only the
    // compaction case (first uuid changed) remains unsafe — tail may be
    // messagesToKeep whose last-actually-recorded uuid differs.
    if (isIncremental || wasFirstRender || isSameHeadShrink) {
      // Match EXACTLY what recordTranscript persists: cleanMessagesForLogging
      // applies both the isLoggableMessage filter and (for external users) the
      // REPL-strip + isVirtual-promote transform. Using the raw predicate here
      // would pick a UUID that the transform drops, leaving the parent hint
      // pointing at a message that never reached disk. Pass full messages as
      // replId context — REPL tool_use and its tool_result land in separate
      // render cycles, so the slice alone can't pair them.
      const last = cleanMessagesForLogging(slice, messages).findLast(
        isChainParticipant,
      )
      if (last) lastParentUuidRef.current = last.uuid as UUID
    }

    lastRecordedLengthRef.current = messages.length
    firstMessageUuidRef.current = currentFirstUuid
  }, [messages, ignore, teamContext?.teamName, teamContext?.selfAgentName])
}
