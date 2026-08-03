import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { PendingClassifierCheck } from '../../../types/permissions.js'
import { isAgentSwarmsEnabled } from '../../../utils/agents/agentSwarmsEnabled.js'
import { toError } from '../../../utils/runtime/errors.js'
import { logError } from '../../../utils/telemetry/log.js'
import type { PermissionDecision } from '../../../utils/permissions/PermissionResult.js'
import type { PermissionUpdate } from '../../../utils/permissions/PermissionUpdateSchema.js'
import {
  createPermissionRequest,
  isSwarmWorker,
  sendPermissionRequestViaMailbox,
} from '../../../utils/swarm/permissionSync.js'
import {
  registerPermissionCallback,
  unregisterPermissionCallback,
} from '../../useSwarmPermissionPoller.js'
import type { PermissionContext } from '../PermissionContext.js'
import { createResolveOnce } from '../PermissionContext.js'

type SwarmWorkerPermissionParams = {
  ctx: PermissionContext
  description: string
  pendingClassifierCheck?: PendingClassifierCheck | undefined
  updatedInput: Record<string, unknown> | undefined
  suggestions: PermissionUpdate[] | undefined
}

type PermissionRequest = ReturnType<typeof createPermissionRequest>

type SwarmWorkerPermissionDependencies = {
  registerPermissionCallback: typeof registerPermissionCallback
  unregisterPermissionCallback: typeof unregisterPermissionCallback
  sendPermissionRequestViaMailbox: typeof sendPermissionRequestViaMailbox
}

const SWARM_WORKER_PERMISSION_DEPENDENCIES: SwarmWorkerPermissionDependencies =
  {
    registerPermissionCallback,
    unregisterPermissionCallback,
    sendPermissionRequestViaMailbox,
  }

async function waitForLeaderPermissionDecision(
  params: SwarmWorkerPermissionParams,
  request: PermissionRequest,
  dependencies: SwarmWorkerPermissionDependencies = SWARM_WORKER_PERMISSION_DEPENDENCIES,
): Promise<PermissionDecision | null> {
  const { ctx, description } = params
  const signal = ctx.toolUseContext.abortController.signal

  const clearPendingRequest = (): void =>
    ctx.toolUseContext.setAppState(prev => ({
      ...prev,
      pendingWorkerRequest: null,
    }))

  return new Promise<PermissionDecision | null>((resolve, reject) => {
    const { resolve: resolveOnce, claim } = createResolveOnce(resolve)

    const cleanup = (): void => {
      dependencies.unregisterPermissionCallback(request.id)
      signal.removeEventListener('abort', onAbort)
      clearPendingRequest()
    }

    const onAbort = (): void => {
      if (!claim()) return
      cleanup()
      ctx.logCancelled()
      resolveOnce(ctx.cancelAndAbort(undefined, true))
    }

    dependencies.registerPermissionCallback({
      requestId: request.id,
      toolUseId: ctx.toolUseID,
      async onAllow(
        allowedInput: Record<string, unknown> | undefined,
        permissionUpdates: PermissionUpdate[],
        feedback?: string,
        contentBlocks?: ContentBlockParam[],
      ) {
        if (!claim()) return
        cleanup()

        const finalInput =
          allowedInput && Object.keys(allowedInput).length > 0
            ? allowedInput
            : ctx.input

        try {
          resolveOnce(
            await ctx.handleUserAllow(
              finalInput,
              permissionUpdates,
              feedback,
              undefined,
              contentBlocks,
            ),
          )
        } catch (error) {
          reject(error)
        }
      },
      onReject(feedback?: string, contentBlocks?: ContentBlockParam[]) {
        if (!claim()) return
        cleanup()

        ctx.logDecision({
          decision: 'reject',
          source: { type: 'user_reject', hasFeedback: !!feedback },
        })

        resolveOnce(ctx.cancelAndAbort(feedback, undefined, contentBlocks))
      },
    })

    ctx.toolUseContext.setAppState(prev => ({
      ...prev,
      pendingWorkerRequest: {
        toolName: ctx.tool.name,
        toolUseId: ctx.toolUseID,
        description,
      },
    }))

    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }

    void dependencies.sendPermissionRequestViaMailbox(request).then(
      sent => {
        if (sent || !claim()) return
        cleanup()
        resolveOnce(null)
      },
      error => {
        if (!claim()) return
        cleanup()
        logError(toError(error))
        resolveOnce(null)
      },
    )
  })
}

/**
 * Handles the swarm worker permission flow.
 *
 * When running as a swarm worker:
 * 1. Tries classifier auto-approval for bash commands
 * 2. Forwards the permission request to the leader via mailbox
 * 3. Registers callbacks for when the leader responds
 * 4. Sets the pending indicator while waiting
 *
 * Returns a PermissionDecision if the classifier auto-approves,
 * or a Promise that resolves when the leader responds.
 * Returns null if swarms are not enabled or this is not a swarm worker,
 * so the caller can fall through to interactive handling.
 */
async function handleSwarmWorkerPermission(
  params: SwarmWorkerPermissionParams,
): Promise<PermissionDecision | null> {
  if (!isAgentSwarmsEnabled() || !isSwarmWorker()) {
    return null
  }

  const { ctx, description, updatedInput, suggestions } = params

  // For bash commands, try classifier auto-approval before forwarding to
  // the leader. Agents await the classifier result (rather than racing it
  // against user interaction like the main agent).
  const classifierResult = feature('BASH_CLASSIFIER')
    ? await ctx.tryClassifier?.(params.pendingClassifierCheck, updatedInput)
    : null
  if (classifierResult) {
    return classifierResult
  }

  // Forward permission request to the leader via mailbox
  try {
    const request = createPermissionRequest({
      toolName: ctx.tool.name,
      toolUseId: ctx.toolUseID,
      input: ctx.input,
      description,
      permissionSuggestions: suggestions,
    })
    return await waitForLeaderPermissionDecision(params, request)
  } catch (error) {
    // If swarm permission submission fails, fall back to local handling
    logError(toError(error))
    // Continue to local UI handling below
    return null
  }
}

export { handleSwarmWorkerPermission }
export type { SwarmWorkerPermissionParams }

export const _test = {
  waitForLeaderPermissionDecision,
}
