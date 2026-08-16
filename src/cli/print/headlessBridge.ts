import { feature } from 'bun:bundle'
import { randomUUID } from 'crypto'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { getSessionId, setMainLoopModelOverride } from 'src/bootstrap/state.js'
import { getRemoteSessionUrl } from 'src/constants/product.js'
import type {
  SDKControlRequest,
  StdoutMessage,
} from 'src/entrypoints/sdk/controlTypes.js'
import { enqueue } from 'src/utils/session/messageQueueManager.js'
import { getDefaultMainLoopModel } from 'src/utils/model/model.js'
import {
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
  isAutoModeGateEnabled,
  isBypassPermissionsModeDisabled,
  transitionPermissionMode,
} from 'src/utils/permissions/permissionSetup.js'
import { errorMessage } from 'src/utils/runtime/errors.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import {
  sendControlResponseError,
  sendControlResponseSuccess,
} from './headlessControlResponses.js'
import type { HeadlessRunState } from './headlessRunState.js'

export function forwardMessagesToBridge(state: HeadlessRunState): void {
  if (!state.bridgeHandle) return
  const startIndex = Math.min(
    state.bridgeLastForwardedIndex,
    state.mutableMessages.length,
  )
  const newMessages = state.mutableMessages
    .slice(startIndex)
    .filter(message => message.type === 'user' || message.type === 'assistant')
  state.bridgeLastForwardedIndex = state.mutableMessages.length
  if (newMessages.length > 0) {
    state.bridgeHandle.writeMessages(newMessages)
  }
}

export async function teardownHeadlessBridge(
  state: HeadlessRunState,
): Promise<void> {
  state.structuredIO.setOnControlRequestSent(undefined)
  state.structuredIO.setOnControlRequestResolved(undefined)
  const handle = state.bridgeHandle
  state.bridgeHandle = null
  state.bridgeLastForwardedIndex = 0
  try {
    await handle?.teardown()
  } catch (error) {
    logForDebugging(`[bridge:sdk] Teardown failed: ${errorMessage(error)}`)
  }
}

export async function handleHeadlessRemoteControl(
  state: HeadlessRunState,
  msg: SDKControlRequest,
  enabled: boolean,
  kickTurn: () => void,
): Promise<void> {
  if (!enabled) {
    await teardownHeadlessBridge(state)
    sendControlResponseSuccess(state, msg)
    return
  }

  const { buildBridgeConnectUrl } = await import(
    'src/bridge/bridgeStatusUtil.js'
  )
  if (state.bridgeHandle) {
    sendControlResponseSuccess(state, msg, {
      session_url: getRemoteSessionUrl(
        state.bridgeHandle.bridgeSessionId,
        state.bridgeHandle.sessionIngressUrl,
      ),
      connect_url: buildBridgeConnectUrl(
        state.bridgeHandle.environmentId,
        state.bridgeHandle.sessionIngressUrl,
        state.bridgeHandle.bridgeSessionId,
      ),
      environment_id: state.bridgeHandle.environmentId,
    })
    return
  }

  let bridgeFailureDetail: string | undefined
  try {
    const { getBridgeBaseUrl, isSelfHostedBridge } = await import(
      'src/bridge/bridgeConfig.js'
    )
    if (isSelfHostedBridge()) {
      const { prepareRemoteControlAuthentication } = await import(
        'src/services/remoteControlAuth/index.js'
      )
      const prepared = await prepareRemoteControlAuthentication(
        getBridgeBaseUrl(),
      )
      if (prepared.status === 'login_required') {
        sendControlResponseError(state, msg, 'auth_required')
        return
      }
    }

    const [{ initReplBridge }, { extractInboundMessageFields }] =
      await Promise.all([
        import('src/bridge/initReplBridge.js'),
        import('src/bridge/inboundMessages.js'),
      ])
    const handle = await initReplBridge({
      onInboundMessage(message) {
        const fields = extractInboundMessageFields(message)
        if (!fields) return
        enqueue({
          value: fields.content as string | ContentBlockParam[],
          mode: 'prompt',
          uuid: fields.uuid,
          skipSlashCommands: true,
        })
        kickTurn()
      },
      onPermissionResponse(response) {
        state.structuredIO.injectControlResponse(response)
      },
      onInterrupt() {
        state.abortController?.abort()
      },
      onSetModel(model) {
        const resolved = model === 'default' ? getDefaultMainLoopModel() : model
        state.activeUserSpecifiedModel = resolved
        setMainLoopModelOverride(resolved)
      },
      onSetMaxThinkingTokens(maxTokens) {
        if (maxTokens === null) {
          state.options.thinkingConfig = undefined
        } else if (maxTokens === 0) {
          state.options.thinkingConfig = { type: 'disabled' }
        } else {
          state.options.thinkingConfig = {
            type: 'enabled',
            budgetTokens: maxTokens,
          }
        }
      },
      onSetPermissionMode(mode) {
        const appState = state.getAppState()
        if (mode === 'bypassPermissions') {
          if (isBypassPermissionsModeDisabled()) {
            return {
              ok: false,
              error:
                'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration',
            }
          }
          if (
            !appState.toolPermissionContext.isBypassPermissionsModeAvailable
          ) {
            return {
              ok: false,
              error:
                'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions',
            }
          }
        }
        if (feature('TRANSCRIPT_CLASSIFIER')) {
          if (mode === 'auto' && !isAutoModeGateEnabled()) {
            const reason = getAutoModeUnavailableReason()
            return {
              ok: false,
              error: reason
                ? `Cannot set permission mode to auto: ${getAutoModeUnavailableNotification(reason)}`
                : 'Cannot set permission mode to auto',
            }
          }
        }
        state.setAppState(prev => {
          if (prev.toolPermissionContext.mode === mode) return prev
          const next = transitionPermissionMode(
            prev.toolPermissionContext.mode,
            mode,
            prev.toolPermissionContext,
          )
          return {
            ...prev,
            toolPermissionContext: { ...next, mode },
          }
        })
        return { ok: true }
      },
      onStateChange(bridgeState, detail) {
        if (bridgeState === 'failed') {
          bridgeFailureDetail = detail
        }
        logForDebugging(
          `[bridge:sdk] State change: ${bridgeState}${detail ? ` — ${detail}` : ''}`,
        )
        state.output.enqueue({
          type: 'system' as StdoutMessage['type'],
          subtype: 'bridge_state',
          state: bridgeState,
          detail,
          uuid: randomUUID(),
          session_id: getSessionId(),
        } as StdoutMessage)
      },
      initialMessages:
        state.mutableMessages.length > 0 ? state.mutableMessages : undefined,
      getMessages: () => state.mutableMessages,
    })
    if (!handle) {
      sendControlResponseError(
        state,
        msg,
        bridgeFailureDetail ?? 'Remote Control initialization failed',
      )
      return
    }

    state.bridgeHandle = handle
    state.bridgeLastForwardedIndex = state.mutableMessages.length
    state.structuredIO.setOnControlRequestSent(request => {
      handle.sendControlRequest(request)
    })
    state.structuredIO.setOnControlRequestResolved(requestId => {
      handle.sendControlCancelRequest(requestId)
    })
    sendControlResponseSuccess(state, msg, {
      session_url: getRemoteSessionUrl(
        handle.bridgeSessionId,
        handle.sessionIngressUrl,
      ),
      connect_url: buildBridgeConnectUrl(
        handle.environmentId,
        handle.sessionIngressUrl,
        handle.bridgeSessionId,
      ),
      environment_id: handle.environmentId,
    })
  } catch (error) {
    sendControlResponseError(state, msg, errorMessage(error))
  }
}
