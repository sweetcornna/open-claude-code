import { feature } from 'bun:bundle'
import type * as React from 'react'
import type { UUID } from 'crypto'
import {
  getOriginalCwd,
  setCostStateForRestore,
  switchSession,
} from '../../bootstrap/state.js'
import {
  getStoredSessionCosts,
  resetCostState,
  saveCurrentSessionCosts,
} from '../../cost-tracker.js'
import { restoreRemoteAgentTasks } from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import { asSessionId } from '../../types/ids.js'
import { updateSessionName } from '../../utils/session/concurrentSessions.js'
import { deserializeMessages } from '../../utils/session/conversationRecovery.js'
import { copyFileHistoryForResume } from '../../utils/filesystem/fileHistory.js'
import {
  executeSessionEndHooks,
  getSessionEndHookTimeoutMs,
} from '../../utils/hooks.js'
import { createSystemMessage } from '../../utils/messages.js'
import { copyPlanForFork, copyPlanForResume } from '../../utils/agents/plans.js'
import {
  computeStandaloneAgentContext,
  exitRestoredWorktree,
  restoreAgentFromSession,
  restoreSessionStateFromLog,
  restoreWorktreeForResume,
} from '../../utils/session/sessionRestore.js'
import { processSessionStartHooks } from '../../utils/session/sessionStart.js'
import {
  adoptResumedSessionFile,
  clearSessionMetadata,
  resetSessionFilePointer,
  restoreSessionMetadata,
  saveWorktreeState,
} from '../../utils/sessionStorage.js'
import { reconstructContentReplacementState } from '../../utils/toolResultStorage.js'
import { getCurrentWorktreeSession } from '../../utils/git/worktree.js'
import { dirname } from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import type { LogOption } from '../../types/logs.js'
import type { ResumeEntrypoint } from '../../commands.js'
import type { Message as MessageType } from '../../types/message.js'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../../utils/session/messageQueueManager.js'
import type { useAppStateStore } from '../../state/AppState.js'
import type { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import type { AgentDefinition } from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'

/**
 * Everything REPL's `resume` closure captured from the component scope.
 *
 * The object is built *inside* the surviving useCallback, so each field still
 * resolves to the same closure variable the inline body read — including the
 * ones the `[resetLoadingState, setAppState]` dep array deliberately omits
 * (mainLoopModel, mainThreadAgentDefinition, ...). Their stale capture is
 * preserved exactly as it was; this extraction does not change it.
 */
export type ResumeContext = {
  agentDefinitions: AppState['agentDefinitions']
  contentReplacementStateRef: {
    current: ReturnType<typeof reconstructContentReplacementState> | undefined
  }
  haikuTitleAttemptedRef: { current: boolean }
  initialMainThreadAgentDefinition: AgentDefinition | undefined
  mainLoopModel: ReturnType<typeof useMainLoopModel>
  mainThreadAgentDefinition: AgentDefinition | undefined
  resetLoadingState: () => void
  restoreReadFileState: (messages: MessageType[], cwd: string) => void
  setAbortController: (controller: AbortController | null) => void
  setAppState: SetAppState
  setConversationId: (id: UUID) => void
  setHaikuTitle: (title: string | undefined) => void
  setInputValue: (value: string) => void
  setMainThreadAgentDefinition: (
    definition: AgentDefinition | undefined,
  ) => void
  setMessages: (action: React.SetStateAction<MessageType[]>) => void
  setToolJSX: (args: null) => void
  store: ReturnType<typeof useAppStateStore>
}

/**
 * Body of REPL's `resume` useCallback, moved out verbatim. The useCallback
 * wrapper and its dep array stay in REPL.tsx, so the hook call order is
 * untouched.
 */
export async function runResume(
  sessionId: UUID,
  log: LogOption,
  entrypoint: ResumeEntrypoint,
  ctx: ResumeContext,
): Promise<void> {
  const {
    agentDefinitions,
    contentReplacementStateRef,
    haikuTitleAttemptedRef,
    initialMainThreadAgentDefinition,
    mainLoopModel,
    mainThreadAgentDefinition,
    resetLoadingState,
    restoreReadFileState,
    setAbortController,
    setAppState,
    setConversationId,
    setHaikuTitle,
    setInputValue,
    setMainThreadAgentDefinition,
    setMessages,
    setToolJSX,
    store,
  } = ctx
  const resumeStart = performance.now()
  try {
    // Deserialize messages to properly clean up the conversation
    // This filters unresolved tool uses and adds a synthetic assistant message if needed
    const messages = deserializeMessages(log.messages)

    // Match coordinator/normal mode to the resumed session
    if (feature('COORDINATOR_MODE')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const coordinatorModule =
        require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      const warning = coordinatorModule.matchSessionMode(log.mode)
      if (warning) {
        // Re-derive agent definitions after mode switch so built-in agents
        // reflect the new coordinator/normal mode
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { getAgentDefinitionsWithOverrides, getActiveAgentsFromList } =
          require('@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js') as typeof import('@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js')
        /* eslint-enable @typescript-eslint/no-require-imports */
        getAgentDefinitionsWithOverrides.cache.clear?.()
        const freshAgentDefs = await getAgentDefinitionsWithOverrides(
          getOriginalCwd(),
        )

        setAppState(prev => ({
          ...prev,
          agentDefinitions: {
            ...freshAgentDefs,
            allAgents: freshAgentDefs.allAgents,
            activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents),
          },
        }))
        messages.push(createSystemMessage(warning, 'warning'))
      }
    }

    // Fire SessionEnd hooks for the current session before starting the
    // resumed one, mirroring the /clear flow in conversation.ts.
    const sessionEndTimeoutMs = getSessionEndHookTimeoutMs()
    await executeSessionEndHooks('resume', {
      getAppState: () => store.getState(),
      setAppState,
      signal: AbortSignal.timeout(sessionEndTimeoutMs),
      timeoutMs: sessionEndTimeoutMs,
    })

    // Process session start hooks for resume
    const hookMessages = await processSessionStartHooks('resume', {
      sessionId,
      agentType: mainThreadAgentDefinition?.agentType,
      model: mainLoopModel,
    })

    // Append hook messages to the conversation
    messages.push(...hookMessages)
    // For forks, generate a new plan slug and copy the plan content so the
    // original and forked sessions don't clobber each other's plan files.
    // For regular resumes, reuse the original session's plan slug.
    if (entrypoint === 'fork') {
      void copyPlanForFork(log, asSessionId(sessionId))
    } else {
      void copyPlanForResume(log, asSessionId(sessionId))
    }

    // Restore file history and attribution state from the resumed conversation
    restoreSessionStateFromLog(log, setAppState)
    if (log.fileHistorySnapshots) {
      void copyFileHistoryForResume(log)
    }

    // Restore agent setting from the resumed conversation
    // Always reset to the new session's values (or clear if none),
    // matching the standaloneAgentContext pattern below
    const { agentDefinition: restoredAgent } = restoreAgentFromSession(
      log.agentSetting,
      initialMainThreadAgentDefinition,
      agentDefinitions,
    )
    setMainThreadAgentDefinition(restoredAgent)
    setAppState(prev => ({ ...prev, agent: restoredAgent?.agentType }))

    // Restore standalone agent context from the resumed conversation
    // Always reset to the new session's values (or clear if none)
    setAppState(prev => ({
      ...prev,
      standaloneAgentContext: computeStandaloneAgentContext(
        log.agentName,
        log.agentColor,
      ),
    }))
    void updateSessionName(log.agentName)

    // Restore read file state from the message history
    restoreReadFileState(messages, log.projectPath ?? getOriginalCwd())

    // Clear any active loading state (no queryId since we're not in a query)
    resetLoadingState()
    setAbortController(null)

    setConversationId(sessionId)

    // Get target session's costs BEFORE saving current session
    // (saveCurrentSessionCosts overwrites the config, so we need to read first)
    const targetSessionCosts = getStoredSessionCosts(sessionId)

    // Save current session's costs before switching to avoid losing accumulated costs
    saveCurrentSessionCosts()

    // Reset cost state for clean slate before restoring target session
    resetCostState()

    // Switch session (id + project dir atomically). fullPath may point to
    // a different project (cross-worktree, /branch); null derives from
    // current originalCwd.
    switchSession(
      asSessionId(sessionId),
      log.fullPath ? dirname(log.fullPath) : null,
    )
    // Rename asciicast recording to match the resumed session ID
    const { renameRecordingForSession } = await import(
      '../../utils/terminal/asciicast.js'
    )
    await renameRecordingForSession()
    await resetSessionFilePointer()

    // Clear then restore session metadata so it's re-appended on exit via
    // reAppendSessionMetadata. clearSessionMetadata must be called first:
    // restoreSessionMetadata only sets-if-truthy, so without the clear,
    // a session without an agent name would inherit the previous session's
    // cached name and write it to the wrong transcript on first message.
    clearSessionMetadata()
    restoreSessionMetadata(log)

    // Hydrate goal state from the resumed session's transcript
    if (feature('GOAL') && log.goal) {
      const { hydrateGoalFromTranscript } =
        require('../../services/goal/goalStorage.js') as typeof import('../../services/goal/goalStorage.js')
      const goalsMap = new Map<UUID, import('../../types/logs.js').GoalState>()
      goalsMap.set(sessionId as UUID, log.goal)
      hydrateGoalFromTranscript(goalsMap, sessionId as UUID)
    }

    // Resumed sessions shouldn't re-title from mid-conversation context
    // (same reasoning as the useRef seed), and the previous session's
    // Haiku title shouldn't carry over.
    haikuTitleAttemptedRef.current = true
    setHaikuTitle(undefined)

    // Exit any worktree a prior /resume entered, then cd into the one
    // this session was in. Without the exit, resuming from worktree B
    // to non-worktree C leaves cwd/currentWorktreeSession stale;
    // resuming B→C where C is also a worktree fails entirely
    // (getCurrentWorktreeSession guard blocks the switch).
    //
    // Skipped for /branch: forkLog doesn't carry worktreeSession, so
    // this would kick the user out of a worktree they're still working
    // in. Same fork skip as processResumedConversation for the adopt —
    // fork materializes its own file via recordTranscript on REPL mount.
    if (entrypoint !== 'fork') {
      exitRestoredWorktree()
      restoreWorktreeForResume(log.worktreeSession)
      adoptResumedSessionFile()
      void restoreRemoteAgentTasks({
        abortController: new AbortController(),
        getAppState: () => store.getState(),
        setAppState,
      })
    } else {
      // Fork: same re-persist as /clear (conversation.ts). The clear
      // above wiped currentSessionWorktree, forkLog doesn't carry it,
      // and the process is still in the same worktree.
      const ws = getCurrentWorktreeSession()
      if (ws) saveWorktreeState(ws)
    }

    // Persist the current mode so future resumes know what mode this session was in
    if (feature('COORDINATOR_MODE')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { saveMode } = require('../utils/sessionStorage.js')
      const { isCoordinatorMode } =
        require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      saveMode(isCoordinatorMode() ? 'coordinator' : 'normal')
    }

    // Restore target session's costs from the data we read earlier
    if (targetSessionCosts) {
      setCostStateForRestore(targetSessionCosts)
    }

    // Reconstruct replacement state for the resumed session. Runs after
    // setSessionId so any NEW replacements post-resume write to the
    // resumed session's tool-results dir. Gated on ref.current: the
    // initial mount already read the feature flag, so we don't re-read
    // it here (mid-session flag flips stay unobservable in both
    // directions).
    //
    // Skipped for in-session /branch: the existing ref is already correct
    // (branch preserves tool_use_ids), so there's no need to reconstruct.
    // createFork() does write content-replacement entries to the forked
    // JSONL with the fork's sessionId, so `claude -r {forkId}` also works.
    if (contentReplacementStateRef.current && entrypoint !== 'fork') {
      contentReplacementStateRef.current = reconstructContentReplacementState(
        messages,
        log.contentReplacements ?? [],
      )
    }

    // Reset messages to the provided initial messages
    // Use a callback to ensure we're not dependent on stale state
    setMessages(() => messages)

    // Clear any active tool JSX
    setToolJSX(null)

    // Clear input to ensure no residual state
    setInputValue('')

    logEvent('tengu_session_resumed', {
      entrypoint:
        entrypoint as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      success: true,
      resume_duration_ms: Math.round(performance.now() - resumeStart),
    })
  } catch (error) {
    logEvent('tengu_session_resumed', {
      entrypoint:
        entrypoint as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      success: false,
    })
    throw error
  }
}
