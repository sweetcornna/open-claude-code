import { feature } from 'bun:bundle'
import type * as React from 'react'
import { useInboxPoller } from '../../hooks/useInboxPoller.js'
import { useMailboxBridge } from '../../hooks/useMailboxBridge.js'
import { useTaskListWatcher } from '../../hooks/useTaskListWatcher.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { enqueue } from '../../utils/session/messageQueueManager.js'
import { createUserMessage } from '../../utils/messages.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import type { Message as MessageType } from '../../types/message.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { QueryGuard } from '../../utils/session/QueryGuard.js'
import type { useAppStateStore, AppState } from '../../state/AppState.js'
import type { useNotifications } from '../../context/notifications.js'
import type { useCommandQueue } from '../../hooks/useCommandQueue.js'

// Dead code elimination: conditional imports. These four hooks are only ever
// called from useReplAutomation, so the requires live here rather than in
// REPL.tsx — external builds drop the modules entirely.
/* eslint-disable @typescript-eslint/no-require-imports */
const useVoiceIntegration: typeof import('../../hooks/useVoiceIntegration.js').useVoiceIntegration =
  feature('VOICE_MODE')
    ? require('../../hooks/useVoiceIntegration.js').useVoiceIntegration
    : () => ({
        stripTrailing: () => 0,
        handleKeyEvent: () => {},
        resetAnchor: () => {},
      })
const useProactive =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('../../proactive/useProactive.js').useProactive
    : null
const useScheduledTasks = feature('AGENT_TRIGGERS')
  ? require('../../hooks/useScheduledTasks.js').useScheduledTasks
  : null
const useGoalContinuation:
  | typeof import('../../hooks/useGoalContinuation.js').useGoalContinuation
  | null = feature('GOAL')
  ? require('../../hooks/useGoalContinuation.js').useGoalContinuation
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

type VoiceOpts = Parameters<typeof useVoiceIntegration>[0]

export type ReplAutomationOpts = {
  setInputValueRaw: VoiceOpts['setInputValueRaw']
  inputValueRef: VoiceOpts['inputValueRef']
  insertTextRef: VoiceOpts['insertTextRef']
  isLoading: boolean
  focusedInputDialog: string | undefined
  handleIncomingPrompt: (
    input: string | QueuedCommand,
    options?: { isMeta?: boolean },
  ) => boolean
  store: ReturnType<typeof useAppStateStore>
  setMessages: (action: React.SetStateAction<MessageType[]>) => void
  taskListId: string | undefined
  initialMessage: AppState['initialMessage']
  queuedCommands: ReturnType<typeof useCommandQueue>
  isShowingLocalJSXCommand: boolean
  toolPermissionContext: ToolPermissionContext
  queryGuard: QueryGuard
  wasAborted: boolean
  addNotification: ReturnType<typeof useNotifications>['addNotification']
}

/**
 * The feature-gated background automation cluster, lifted verbatim out of
 * REPL.tsx and called from the exact position the block used to occupy so the
 * hook call order is byte-for-byte unchanged.
 *
 * Every gate keeps its original shape: `feature()` stays in `if`-condition or
 * ternary-condition position (the Bun compiler rejects it anywhere else), and
 * the `useProactive?.` / `useGoalContinuation?.` optional calls stay optional.
 *
 * The return type is inferred on purpose: `voice` is the union of the real
 * integration result and the no-op fallback, exactly as it was inline in
 * REPL.tsx. Annotating it narrows one branch and breaks `voice.interimRange`.
 */
export function useReplAutomation({
  setInputValueRaw,
  inputValueRef,
  insertTextRef,
  isLoading,
  focusedInputDialog,
  handleIncomingPrompt,
  store,
  setMessages,
  taskListId,
  initialMessage,
  queuedCommands,
  isShowingLocalJSXCommand,
  toolPermissionContext,
  queryGuard,
  wasAborted,
  addNotification,
}: ReplAutomationOpts) {
  // Voice input integration (VOICE_MODE builds only)
  const voiceIntegrationResult = useVoiceIntegration({
    setInputValueRaw,
    inputValueRef,
    insertTextRef,
  })
  const voice = feature('VOICE_MODE')
    ? voiceIntegrationResult
    : {
        stripTrailing: () => 0,
        handleKeyEvent: () => {},
        resetAnchor: () => {},
        interimRange: null,
      }

  useInboxPoller({
    enabled: isAgentSwarmsEnabled(),
    isLoading,
    focusedInputDialog,
    onSubmitMessage: handleIncomingPrompt,
  })

  useMailboxBridge({ isLoading, onSubmitMessage: handleIncomingPrompt })
  // Scheduled tasks from .claude/scheduled_tasks.json (CronCreate/Delete/List)
  if (feature('AGENT_TRIGGERS')) {
    // Assistant mode bypasses the isLoading gate (a busy proactive tick
    // loop would otherwise starve the scheduler).
    // kairosEnabled is set once in initialState (main.tsx) and never mutated — no
    // subscription needed. The tengu_kairos_cron runtime gate is checked inside
    // useScheduledTasks's effect (not here) since wrapping a hook call in a dynamic
    // condition would break rules-of-hooks.
    const assistantMode = store.getState().kairosEnabled
    useScheduledTasks!({ isLoading, assistantMode, setMessages })
  }

  // Note: Permission polling is now handled by useInboxPoller
  // - Workers receive permission responses via mailbox messages
  // - Leaders receive permission requests via mailbox messages

  if (process.env.USER_TYPE === 'ant') {
    // Tasks mode: watch for tasks and auto-process them
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useTaskListWatcher({
      taskListId,
      isLoading,
      onSubmitTask: handleIncomingPrompt,
    })
  }

  // Proactive mode: auto-tick when enabled (via /proactive command)
  // Moved out of USER_TYPE === 'ant' block so external users can use it.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useProactive?.({
    // Suppress ticks while an initial message is pending — the initial
    // message will be processed asynchronously and a premature tick would
    // race with it, causing concurrent-query enqueue of expanded skill text.
    isLoading: isLoading || initialMessage !== null,
    queuedCommandsLength: queuedCommands.length,
    hasActiveLocalJsxUI: isShowingLocalJSXCommand,
    isInPlanMode: toolPermissionContext.mode === 'plan',
    onQueueTick: (command: QueuedCommand) => enqueue(command),
  })

  // Goal auto-continuation: enqueue a steering prompt when idle + active goal
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useGoalContinuation?.({
    isLoading: isLoading || initialMessage !== null,
    wasAborted,
    queuedCommandsLength: queuedCommands.length,
    hasActiveLocalJsxUI: isShowingLocalJSXCommand,
    isInPlanMode: toolPermissionContext.mode === 'plan',
    isQueryActiveNow: queryGuard.getSnapshot,
    onContinuationEnqueued: ({ turn, objective }) => {
      const visibleGoalTurnInput = `Goal auto-continue (${turn}/1): continue advancing "${objective}".`
      setMessages(oldMessages => [
        ...oldMessages,
        createUserMessage({
          content: visibleGoalTurnInput,
          isVisibleInTranscriptOnly: true,
        }),
      ])
    },
    onMaxTurnsReached: () => {
      addNotification({
        key: 'goal-max-turns-reached',
        text: 'Goal reached max continuation turns (1). Run /goal continue to reset turn counter and continue.',
        priority: 'immediate',
      })
    },
  })

  return { voice }
}
