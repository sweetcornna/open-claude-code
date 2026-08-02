/**
 * The headless stdin reader.
 *
 * One of the session's two long-lived drivers (the other is the turn loop).
 * It classifies each inbound structured message: control requests go to the
 * control chain, replay/keep-alive/env-var messages are absorbed, transcript
 * replay is injected into the conversation, and user prompts are
 * de-duplicated and enqueued — each enqueue starting a turn.
 *
 * When the stream ends (or end_session stops it) input is marked closed, cron
 * is stopped, and the output stream is finalized unless a turn is still
 * running — in that case the turn's own tail does it.
 */
import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type {
  SDKMessage,
  SDKUserMessage,
} from 'src/entrypoints/agentSdkTypes.js'
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { resolveAndPrepend } from 'src/cli/inboundAttachments.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/telemetry/diagLogs.js'
import { notifyCommandLifecycle } from 'src/utils/commandLifecycle.js'
import { enqueue } from 'src/utils/messageQueueManager.js'
import { toInternalMessages } from 'src/utils/messages/mappers.js'
import { incrementPromptCount } from 'src/utils/commitAttribution.js'
import {
  doesMessageExistInSession,
  recordAttributionSnapshot,
} from 'src/utils/sessionStorage.js'
import { handleHeadlessControlRequest } from './headlessControlRequests.js'
import { finalizeHeadlessOutput } from './headlessTeardown.js'
import { runHeadlessTurn } from './headlessTurnLoop.js'
import { receivedMessageUuids, trackReceivedMessageUuid } from './runtime.js'
import type { HeadlessRunState } from './headlessRunState.js'

/**
 * Read stdin until the stream ends or end_session stops it. Runs
 * concurrently with the turn loop; the two meet at the command queue.
 */
export async function runHeadlessInputLoop(
  state: HeadlessRunState,
): Promise<void> {
  logForDiagnosticsNoPII('info', 'cli_message_loop_started')
  for await (const message of state.structuredIO.structuredInput) {
    // Non-user events are handled inline (no queue). started→completed in
    // the same tick carries no information, so only fire completed.
    // control_response is reported by StructuredIO.processLine (which also
    // sees orphans that never yield here).
    const eventId = 'uuid' in message ? message.uuid : undefined
    if (
      eventId &&
      message.type !== 'user' &&
      message.type !== 'control_response'
    ) {
      notifyCommandLifecycle(eventId as string, 'completed')
    }

    if (message.type === 'control_request') {
      if ((await handleHeadlessControlRequest(state, message)) === 'stop') {
        break // falls through to inputClosed=true drain below
      }
      continue
    } else if (message.type === 'control_response') {
      // Replay control_response messages when replay mode is enabled
      if (state.options.replayUserMessages) {
        state.output.enqueue(message as StdoutMessage)
      }
      continue
    } else if (message.type === 'keep_alive') {
      // Silently ignore keep-alive messages
      continue
    } else if (message.type === 'update_environment_variables') {
      // Handled in state.structuredIO.ts, but TypeScript needs the type guard
      continue
    } else if (message.type === 'assistant' || message.type === 'system') {
      // History replay from bridge: inject into state.mutableMessages as
      // conversation context so the model sees prior turns.
      const internalMsgs = toInternalMessages([message as SDKMessage])
      state.mutableMessages.push(...internalMsgs)
      // Echo assistant messages back so CCR displays them
      if (message.type === 'assistant' && state.options.replayUserMessages) {
        state.output.enqueue(message as StdoutMessage)
      }
      continue
    }
    // After handling control, keep-alive, env-var, assistant, and system
    // messages above, only user messages should remain.
    if (message.type !== 'user') {
      continue
    }
    // Type assertion: after the type guard, message is a user message.
    // The union with SDKMessage (any) prevents proper narrowing.
    const userMsg = message as SDKUserMessage

    // First prompt message implicitly initializes if not already done.
    state.initialized = true

    // Check for duplicate user message - skip if already processed
    if (userMsg.uuid) {
      const sessionId = getSessionId() as UUID
      const existsInSession = await doesMessageExistInSession(
        sessionId,
        userMsg.uuid as UUID,
      )

      // Check both historical duplicates (from file) and runtime duplicates (this session)
      if (existsInSession || receivedMessageUuids.has(userMsg.uuid as UUID)) {
        logForDebugging(`Skipping duplicate user message: ${userMsg.uuid}`)
        // Send acknowledgment for duplicate message if replay mode is enabled
        if (state.options.replayUserMessages) {
          logForDebugging(
            `Sending acknowledgment for duplicate user message: ${userMsg.uuid}`,
          )
          state.output.enqueue({
            type: 'user',
            content: (userMsg.message as { content?: string })?.content ?? '',
            message: userMsg.message as unknown,
            session_id: sessionId,
            parent_tool_use_id: null,
            uuid: userMsg.uuid as string,
            timestamp: (userMsg as { timestamp?: string }).timestamp,
            isReplay: true,
          } as unknown as StdoutMessage)
        }
        // Historical dup = transcript already has this turn's output, so it
        // ran but its lifecycle was never closed (interrupted before ack).
        // Runtime dups don't need this — the original enqueue path closes them.
        if (existsInSession) {
          notifyCommandLifecycle(userMsg.uuid as string, 'completed')
        }
        // Don't enqueue duplicate messages for execution
        continue
      }

      // Track this UUID to prevent runtime duplicates
      trackReceivedMessageUuid(userMsg.uuid as UUID)
    }

    enqueue({
      mode: 'prompt' as const,
      // file_attachments rides the protobuf catchall from the web composer.
      // Same-ref no-op when absent (no 'file_attachments' key).
      value: await resolveAndPrepend(
        userMsg,
        (userMsg.message as { content: ContentBlockParam[] }).content,
      ),
      uuid: userMsg.uuid as `${string}-${string}-${string}-${string}-${string}`,
      priority: (userMsg as { priority?: string })
        .priority as import('src/types/textInputTypes.js').QueuePriority,
    })
    // Increment prompt count for attribution tracking and save snapshot
    // The snapshot persists promptCount so it survives compaction
    if (feature('COMMIT_ATTRIBUTION')) {
      state.setAppState(prev => ({
        ...prev,
        attribution: incrementPromptCount(prev.attribution, snapshot => {
          void recordAttributionSnapshot(snapshot).catch(error => {
            logForDebugging(`Attribution: Failed to save snapshot: ${error}`)
          })
        }),
      }))
    }
    void runHeadlessTurn(state)
  }
  state.inputClosed = true
  state.cronScheduler?.stop()
  if (!state.running) {
    await finalizeHeadlessOutput(state)
  }
}
