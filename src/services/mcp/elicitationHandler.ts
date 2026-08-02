import type {
  Client,
  ElicitRequestParams,
  ElicitResult,
} from '@modelcontextprotocol/client'
import type { AppState } from '../../state/AppState.js'
import {
  executeElicitationHooks,
  executeElicitationResultHooks,
  executeNotificationHooks,
} from '../../utils/hooks.js'
import { logMCPDebug, logMCPError } from '../../utils/telemetry/log.js'
import { jsonStringify } from '../../utils/telemetry/slowOperations.js'
import { currentMrtrRound } from './mrtrRounds.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

/** Configuration for the waiting state shown after the user opens a URL. */
export type ElicitationWaitingState = {
  /** Button label, e.g. "Retry now" or "Skip confirmation" */
  actionLabel: string
  /** Whether to show a visible Cancel button (e.g. for error-based retry flow) */
  showCancel?: boolean
}

export type ElicitationRequestEvent = {
  serverName: string
  /**
   * Correlation id for the request.
   *
   * On a legacy-era connection this is the JSON-RPC request id, unique per
   * server connection. On the modern era (2026-07-28) the elicitation arrives
   * embedded in an `input_required` result instead, and the SDK synthesizes
   * the context with the `inputRequests` KEY as its id — a server-chosen label
   * that is only unique within one round and typically REPEATS across the
   * rounds of a single exchange. Pair it with {@link ElicitationRequestEvent.round}
   * wherever identity has to survive a round boundary (React keys, dedupe).
   */
  requestId: string | number
  /**
   * 1-based multi-round-trip round this elicitation belongs to, or `undefined`
   * on a legacy-era connection (and on the modern era when the round could not
   * be recovered — see `mrtrRounds.ts`). Display and identity only.
   */
  round?: number
  params: ElicitRequestParams
  signal: AbortSignal
  /**
   * Resolves the elicitation. For explicit elicitations, all actions are
   * meaningful. For error-based retry (-32042), 'accept' is a no-op —
   * the retry is driven by onWaitingDismiss instead.
   */
  respond: (response: ElicitResult) => void
  /** For URL elicitations: shown after user opens the browser. */
  waitingState?: ElicitationWaitingState
  /** Called when phase 2 (waiting) is dismissed by user action or completion. */
  onWaitingDismiss?: (action: 'dismiss' | 'retry' | 'cancel') => void
  /** Set to true by the completion notification handler when the server confirms completion. */
  completed?: boolean
}

function getElicitationMode(params: ElicitRequestParams): 'form' | 'url' {
  return params.mode === 'url' ? 'url' : 'form'
}

/** Find a queued elicitation event by server name and elicitationId. */
function findElicitationInQueue(
  queue: ElicitationRequestEvent[],
  serverName: string,
  elicitationId: string,
): number {
  return queue.findIndex(
    e =>
      e.serverName === serverName &&
      e.params.mode === 'url' &&
      'elicitationId' in e.params &&
      e.params.elicitationId === elicitationId,
  )
}

export function registerElicitationHandler(
  client: Client,
  serverName: string,
  setAppState: (f: (prevState: AppState) => AppState) => void,
): void {
  // Register the elicitation request handler.
  // Wrapped in try/catch because setRequestHandler throws if the client wasn't
  // created with elicitation capability declared.
  try {
    client.setRequestHandler('elicitation/create', async (request, ctx) => {
      const { signal, id: requestId } = ctx.mcpReq
      // Read before awaiting anything: the driver reports the round on the
      // originating call's `onprogress` immediately before dispatching this
      // round's embedded requests, so the tracker is current on entry and can
      // advance once a later round starts.
      const round = currentMrtrRound(client)
      logMCPDebug(
        serverName,
        `Received elicitation request${round !== undefined ? ` (round ${round})` : ''}: ${jsonStringify(request)}`,
      )

      const mode = getElicitationMode(request.params)

      logEvent('tengu_mcp_elicitation_shown', {
        mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })

      try {
        // Run elicitation hooks first - they can provide a response programmatically
        const hookResponse = await runElicitationHooks(
          serverName,
          request.params,
          signal,
        )
        if (hookResponse) {
          logMCPDebug(
            serverName,
            `Elicitation resolved by hook: ${jsonStringify(hookResponse)}`,
          )
          logEvent('tengu_mcp_elicitation_response', {
            mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            action:
              hookResponse.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          return hookResponse
        }

        const elicitationId =
          mode === 'url' && 'elicitationId' in request.params
            ? (request.params.elicitationId as string | undefined)
            : undefined

        const response = new Promise<ElicitResult>(resolve => {
          const onAbort = () => {
            resolve({ action: 'cancel' })
          }

          if (signal.aborted) {
            onAbort()
            return
          }

          const waitingState: ElicitationWaitingState | undefined =
            elicitationId ? { actionLabel: 'Skip confirmation' } : undefined

          setAppState(prev => ({
            ...prev,
            elicitation: {
              queue: [
                ...prev.elicitation.queue,
                {
                  serverName,
                  requestId,
                  ...(round !== undefined && { round }),
                  params: request.params,
                  signal: signal,
                  waitingState,
                  respond: (result: ElicitResult) => {
                    signal.removeEventListener('abort', onAbort)
                    logEvent('tengu_mcp_elicitation_response', {
                      mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                      action:
                        result.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                    })
                    resolve(result)
                  },
                },
              ],
            },
          }))

          signal.addEventListener('abort', onAbort, { once: true })
        })
        const rawResult = await response
        logMCPDebug(
          serverName,
          `Elicitation response: ${jsonStringify(rawResult)}`,
        )
        const result = await runElicitationResultHooks(
          serverName,
          rawResult,
          signal,
          mode,
          elicitationId,
        )
        return result
      } catch (error) {
        logMCPError(serverName, `Elicitation error: ${error}`)
        return { action: 'cancel' as const }
      }
    })

    // Register handler for elicitation completion notifications (URL mode).
    // Sets `completed: true` on the matching queue event; the dialog reacts to this flag.
    client.setNotificationHandler(
      'notifications/elicitation/complete',
      notification => {
        const { elicitationId } = notification.params
        logMCPDebug(
          serverName,
          `Received elicitation completion notification: ${elicitationId}`,
        )
        void executeNotificationHooks({
          message: `MCP server "${serverName}" confirmed elicitation ${elicitationId} complete`,
          notificationType: 'elicitation_complete',
        })
        let found = false
        setAppState(prev => {
          const idx = findElicitationInQueue(
            prev.elicitation.queue,
            serverName,
            elicitationId,
          )
          if (idx === -1) return prev
          found = true
          const queue = [...prev.elicitation.queue]
          queue[idx] = { ...queue[idx]!, completed: true }
          return { ...prev, elicitation: { queue } }
        })
        if (!found) {
          logMCPDebug(
            serverName,
            `Ignoring completion notification for unknown elicitation: ${elicitationId}`,
          )
        }
      },
    )
  } catch {
    // Client wasn't created with elicitation capability - nothing to register
    return
  }
}

export async function runElicitationHooks(
  serverName: string,
  params: ElicitRequestParams,
  signal: AbortSignal,
): Promise<ElicitResult | undefined> {
  try {
    const mode = params.mode === 'url' ? 'url' : 'form'
    const url = 'url' in params ? (params.url as string) : undefined
    const elicitationId =
      'elicitationId' in params
        ? (params.elicitationId as string | undefined)
        : undefined

    const { elicitationResponse, blockingError } =
      await executeElicitationHooks({
        serverName,
        message: params.message,
        requestedSchema:
          'requestedSchema' in params
            ? (params.requestedSchema as Record<string, unknown>)
            : undefined,
        signal,
        mode,
        url,
        elicitationId,
      })

    if (blockingError) {
      return { action: 'decline' }
    }

    if (elicitationResponse) {
      return {
        action: elicitationResponse.action,
        content: elicitationResponse.content,
      }
    }

    return undefined
  } catch (error) {
    logMCPError(serverName, `Elicitation hook error: ${error}`)
    return undefined
  }
}

/**
 * Run ElicitationResult hooks after the user has responded, then fire a
 * `elicitation_response` notification. Returns a (potentially modified)
 * ElicitResult — hooks may override the action/content or block the response.
 */
export async function runElicitationResultHooks(
  serverName: string,
  result: ElicitResult,
  signal: AbortSignal,
  mode?: 'form' | 'url',
  elicitationId?: string,
): Promise<ElicitResult> {
  try {
    const { elicitationResultResponse, blockingError } =
      await executeElicitationResultHooks({
        serverName,
        action: result.action,
        content: result.content as Record<string, unknown> | undefined,
        signal,
        mode,
        elicitationId,
      })

    if (blockingError) {
      void executeNotificationHooks({
        message: `Elicitation response for server "${serverName}": decline`,
        notificationType: 'elicitation_response',
      })
      return { action: 'decline' }
    }

    const finalResult = elicitationResultResponse
      ? {
          action: elicitationResultResponse.action,
          content: elicitationResultResponse.content ?? result.content,
        }
      : result

    // Fire a notification for observability
    void executeNotificationHooks({
      message: `Elicitation response for server "${serverName}": ${finalResult.action}`,
      notificationType: 'elicitation_response',
    })

    return finalResult
  } catch (error) {
    logMCPError(serverName, `ElicitationResult hook error: ${error}`)
    // Fire notification even on error
    void executeNotificationHooks({
      message: `Elicitation response for server "${serverName}": ${result.action}`,
      notificationType: 'elicitation_response',
    })
    return result
  }
}
