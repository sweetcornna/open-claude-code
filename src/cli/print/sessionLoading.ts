import { feature } from 'bun:bundle'
import { dirname } from 'path'
import { randomUUID } from 'crypto'
import { EMPTY_USAGE } from '@ant/model-provider'
import { BIN_NAME } from 'src/constants/brand.js'
import type { Message, NormalizedUserMessage } from 'src/types/message.js'
import type { TurnInterruptionState } from 'src/utils/session/conversationRecovery.js'
import {
  loadConversationForResume,
  validateResumeDropRange,
} from 'src/utils/session/conversationRecovery.js'
import type { AppState } from 'src/state/AppStateStore.js'
import type { SessionExternalMetadata } from 'src/utils/session/sessionState.js'
import { processSessionStartHooks } from 'src/utils/session/sessionStart.js'
import { getSessionId } from 'src/bootstrap/state.js'
import { jsonStringify } from 'src/utils/telemetry/slowOperations.js'
import { isSessionPersistenceDisabled } from 'src/bootstrap/state.js'
import { logEvent } from 'src/services/analytics/index.js'
import { logError } from 'src/utils/telemetry/log.js'
import { gracefulShutdownSync } from 'src/utils/process/gracefulShutdown.js'
import { isPolicyAllowed } from 'src/services/policyLimits/index.js'
import { parseSessionIdentifier } from 'src/utils/session/sessionUrl.js'
import { isEnvTruthy } from 'src/utils/config/envUtils.js'
import {
  hydrateFromCCRv2InternalEvents,
  hydrateRemoteSession,
  resetSessionFilePointer,
  restoreSessionMetadata,
  saveMode,
} from 'src/utils/sessionStorage.js'
import { externalMetadataToAppState } from 'src/state/onChangeAppState.js'
import { setMainLoopModelOverride, switchSession } from 'src/bootstrap/state.js'
import { asSessionId } from 'src/types/ids.js'
import { getCwd } from 'src/utils/filesystem/cwd.js'
import { restoreSessionStateFromLog } from 'src/utils/session/sessionRestore.js'
import { searchSessionsByCustomTitle } from 'src/utils/sessionStorage/sessionListing.js'
import { getSessionIdFromLog } from 'src/utils/sessionStorage/logAssembly.js'
import { coordinatorModeModule } from './runtime.js'

/**
 * Emits an error message in the correct format based on outputFormat.
 * When using stream-json, writes JSON to stdout; otherwise writes plain text to stderr.
 */
function emitLoadError(
  message: string,
  outputFormat: string | undefined,
): void {
  if (outputFormat === 'stream-json') {
    const errorResult = {
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 0,
      stop_reason: null,
      session_id: getSessionId(),
      total_cost_usd: 0,
      usage: EMPTY_USAGE,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      errors: [message],
    }
    process.stdout.write(jsonStringify(errorResult) + '\n')
  } else {
    process.stderr.write(message + '\n')
  }
}

/**
 * Removes an interrupted user message and its synthetic assistant sentinel
 * from the message array. Used during gateway-triggered restarts to clean up
 * the message history before re-enqueuing the interrupted prompt.
 *
 * @internal Exported for testing
 */
export function removeInterruptedMessage(
  messages: Message[],
  interruptedUserMessage: NormalizedUserMessage,
): void {
  const idx = messages.findIndex(m => m.uuid === interruptedUserMessage.uuid)
  if (idx !== -1) {
    // Remove the user message and the sentinel that immediately follows it.
    // splice safely handles the case where idx is the last element.
    messages.splice(idx, 2)
  }
}

type LoadInitialMessagesResult = {
  messages: Message[]
  turnInterruptionState?: TurnInterruptionState
  agentSetting?: string
  resumedSession?: boolean
}

async function loadInitialMessages(
  setAppState: (f: (prev: AppState) => AppState) => void,
  options: {
    continue: boolean | undefined
    teleport: string | true | null | undefined
    resume: string | boolean | undefined
    resumeSessionAt: string | undefined
    resumeDropsTurn: string | undefined
    forkSession: boolean | undefined
    outputFormat: string | undefined
    sessionStartHooksPromise?: ReturnType<typeof processSessionStartHooks>
    restoredWorkerState: Promise<SessionExternalMetadata | null>
  },
): Promise<LoadInitialMessagesResult> {
  const persistSession = !isSessionPersistenceDisabled()
  // Handle continue in print mode
  if (options.continue) {
    try {
      logEvent('tengu_continue_print', {})

      const result = await loadConversationForResume(
        undefined /* sessionId */,
        undefined /* file path */,
      )
      if (result) {
        // Match coordinator mode to the resumed session's mode
        if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
          const warning = coordinatorModeModule.matchSessionMode(result.mode)
          if (warning) {
            process.stderr.write(warning + '\n')
            // Refresh agent definitions to reflect the mode switch
            const {
              getAgentDefinitionsWithOverrides,
              getActiveAgentsFromList,
            } =
              // eslint-disable-next-line @typescript-eslint/no-require-imports
              require('@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js') as typeof import('@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js')
            getAgentDefinitionsWithOverrides.cache.clear?.()
            const freshAgentDefs = await getAgentDefinitionsWithOverrides(
              getCwd(),
            )

            setAppState(prev => ({
              ...prev,
              agentDefinitions: {
                ...freshAgentDefs,
                allAgents: freshAgentDefs.allAgents,
                activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents),
              },
            }))
          }
        }

        // Reuse the resumed session's ID
        if (!options.forkSession) {
          if (result.sessionId) {
            switchSession(
              asSessionId(result.sessionId),
              result.fullPath ? dirname(result.fullPath) : null,
            )
            if (persistSession) {
              await resetSessionFilePointer()
            }
          }
        }
        restoreSessionStateFromLog(result, setAppState)

        // Restore session metadata so it's re-appended on exit via reAppendSessionMetadata
        restoreSessionMetadata(
          options.forkSession
            ? { ...result, worktreeSession: undefined }
            : result,
        )

        // Write mode entry for the resumed session
        if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
          saveMode(
            coordinatorModeModule.isCoordinatorMode()
              ? 'coordinator'
              : 'normal',
          )
        }

        return {
          messages: result.messages,
          turnInterruptionState: result.turnInterruptionState,
          agentSetting: result.agentSetting,
        }
      }
    } catch (error) {
      logError(error)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  // Handle teleport in print mode
  if (options.teleport) {
    try {
      if (!isPolicyAllowed('allow_remote_sessions')) {
        throw new Error(
          "Remote sessions are disabled by your organization's policy.",
        )
      }

      logEvent('tengu_teleport_print', {})

      if (typeof options.teleport !== 'string') {
        throw new Error('No session ID provided for teleport')
      }

      const {
        checkOutTeleportedSessionBranch,
        processMessagesForTeleportResume,
        teleportResumeCodeSession,
        validateGitState,
      } = await import('src/utils/teleport/teleport.js')
      await validateGitState()
      const teleportResult = await teleportResumeCodeSession(options.teleport)
      const { branchError } = await checkOutTeleportedSessionBranch(
        teleportResult.branch,
      )
      return {
        messages: processMessagesForTeleportResume(
          teleportResult.log,
          branchError,
        ),
      }
    } catch (error) {
      logError(error)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  // Handle resume in print mode (accepts session ID or URL)
  // URLs are [ANT-ONLY]
  if (options.resume) {
    try {
      logEvent('tengu_resume_print', {})

      const resumeIdentifier =
        typeof options.resume === 'string' ? options.resume : ''
      let parsedSessionId = parseSessionIdentifier(resumeIdentifier)
      if (!parsedSessionId && resumeIdentifier.trim()) {
        const titleMatches = await searchSessionsByCustomTitle(
          resumeIdentifier,
          {
            exact: true,
          },
        )
        if (titleMatches.length > 1) {
          const matches = titleMatches
            .map(log => {
              const sessionId = getSessionIdFromLog(log) ?? 'unknown'
              return `- ${sessionId} (${log.modified.toISOString()})`
            })
            .join('\n')
          emitLoadError(
            `Multiple sessions match title "${resumeIdentifier}":\n${matches}\nUse a session ID to disambiguate.`,
            options.outputFormat,
          )
          gracefulShutdownSync(1)
          return { messages: [] }
        }
        const sessionId =
          titleMatches.length === 1
            ? getSessionIdFromLog(titleMatches[0]!)
            : undefined
        if (sessionId) parsedSessionId = parseSessionIdentifier(sessionId)
      }
      if (!parsedSessionId) {
        emitLoadError(
          `Error: --resume requires a valid session ID, JSONL file, URL, or exact session title when used with --print. Usage: ${BIN_NAME} -p --resume <session-id-or-title>`,
          options.outputFormat,
        )
        gracefulShutdownSync(1)
        return { messages: [] }
      }

      // Hydrate local transcript from remote before loading
      if (isEnvTruthy(process.env.CLAUDE_CODE_USE_CCR_V2)) {
        // Await restore alongside hydration so SSE catchup lands on
        // restored state, not a fresh default.
        const [, metadata] = await Promise.all([
          hydrateFromCCRv2InternalEvents(parsedSessionId.sessionId),
          options.restoredWorkerState,
        ])
        if (metadata) {
          setAppState(externalMetadataToAppState(metadata))
          if (typeof metadata.model === 'string') {
            setMainLoopModelOverride(metadata.model)
          }
        }
      } else if (
        parsedSessionId.isUrl &&
        parsedSessionId.ingressUrl &&
        isEnvTruthy(process.env.ENABLE_SESSION_PERSISTENCE)
      ) {
        // v1: fetch session logs from Session Ingress
        await hydrateRemoteSession(
          parsedSessionId.sessionId,
          parsedSessionId.ingressUrl,
        )
      }

      // Load the conversation with the specified session ID
      const result = await loadConversationForResume(
        parsedSessionId.sessionId,
        parsedSessionId.jsonlFile || undefined,
      )

      // hydrateFromCCRv2InternalEvents writes an empty transcript file for
      // fresh sessions (writeFile(sessionFile, '') with zero events), so
      // loadConversationForResume returns {messages: []} not null. Treat
      // empty the same as null so SessionStart still fires.
      if (!result || result.messages.length === 0) {
        // For URL-based or CCR v2 resume, start with empty session (it was hydrated but empty)
        if (
          parsedSessionId.isUrl ||
          isEnvTruthy(process.env.CLAUDE_CODE_USE_CCR_V2)
        ) {
          // Execute SessionStart hooks for startup since we're starting a new session
          return {
            messages: await (options.sessionStartHooksPromise ??
              processSessionStartHooks('startup')),
          }
        } else {
          emitLoadError(
            `No conversation found with session ID: ${parsedSessionId.sessionId}`,
            options.outputFormat,
          )
          gracefulShutdownSync(1)
          return { messages: [] }
        }
      }

      // Handle resumeSessionAt feature
      if (options.resumeSessionAt) {
        const index = result.messages.findIndex(
          m => m.uuid === options.resumeSessionAt,
        )
        if (index < 0) {
          emitLoadError(
            `No message found with message.uuid of: ${options.resumeSessionAt}`,
            options.outputFormat,
          )
          gracefulShutdownSync(1)
          return { messages: [] }
        }

        if (options.resumeDropsTurn !== undefined) {
          const guard = validateResumeDropRange(
            result.messages.slice(index + 1),
            options.resumeDropsTurn,
          )
          if (!guard.ok) {
            emitLoadError(
              `Resume rejected by --resume-drops-turn: resuming at ${options.resumeSessionAt} would discard entries not attributable to turn ${options.resumeDropsTurn}: ${guard.reason}`,
              options.outputFormat,
            )
            gracefulShutdownSync(1)
            return { messages: [] }
          }
        }
        result.messages = result.messages.slice(0, index + 1)
      }

      // Match coordinator mode to the resumed session's mode
      if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
        const warning = coordinatorModeModule.matchSessionMode(result.mode)
        if (warning) {
          process.stderr.write(warning + '\n')
          // Refresh agent definitions to reflect the mode switch
          const { getAgentDefinitionsWithOverrides, getActiveAgentsFromList } =
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js') as typeof import('@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js')
          getAgentDefinitionsWithOverrides.cache.clear?.()
          const freshAgentDefs = await getAgentDefinitionsWithOverrides(
            getCwd(),
          )

          setAppState(prev => ({
            ...prev,
            agentDefinitions: {
              ...freshAgentDefs,
              allAgents: freshAgentDefs.allAgents,
              activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents),
            },
          }))
        }
      }

      // Reuse the resumed session's ID
      if (!options.forkSession && result.sessionId) {
        switchSession(
          asSessionId(result.sessionId),
          result.fullPath ? dirname(result.fullPath) : null,
        )
        if (persistSession) {
          await resetSessionFilePointer()
        }
      }
      restoreSessionStateFromLog(result, setAppState)

      // Restore session metadata so it's re-appended on exit via reAppendSessionMetadata
      restoreSessionMetadata(
        options.forkSession
          ? { ...result, worktreeSession: undefined }
          : result,
      )

      // Write mode entry for the resumed session
      if (feature('COORDINATOR_MODE') && coordinatorModeModule) {
        saveMode(
          coordinatorModeModule.isCoordinatorMode() ? 'coordinator' : 'normal',
        )
      }

      return {
        messages: result.messages,
        turnInterruptionState: result.turnInterruptionState,
        agentSetting: result.agentSetting,
        resumedSession: true,
      }
    } catch (error) {
      logError(error)
      const errorMessage =
        error instanceof Error
          ? `Failed to resume session: ${error.message}`
          : 'Failed to resume session with --print mode'
      emitLoadError(errorMessage, options.outputFormat)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  // Join the SessionStart hooks promise kicked in main.tsx (or run fresh if
  // it wasn't kicked — e.g. --continue with no prior session falls through
  // here with sessionStartHooksPromise undefined because main.tsx guards on continue)
  return {
    messages: await (options.sessionStartHooksPromise ??
      processSessionStartHooks('startup')),
  }
}

export { loadInitialMessages }
