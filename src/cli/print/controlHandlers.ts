import { feature } from 'bun:bundle'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import {
  type AgentDefinition,
  isBuiltInAgent,
  parseAgentsFromJson,
} from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import type { AppState } from 'src/state/AppStateStore.js'
import type { Command } from 'src/commands.js'
import { formatDescriptionWithSource, getCommandName } from 'src/commands.js'
import type { Stream } from 'src/utils/collections/stream.js'
import { StructuredIO } from 'src/cli/structuredIO.js'
import type {
  ModelInfo,
  RewindFilesResult,
} from 'src/entrypoints/agentSdkTypes.js'
import type {
  SDKControlInitializeRequest,
  SDKControlInitializeResponse,
  StdoutMessage,
} from 'src/entrypoints/sdk/controlTypes.js'
import { getCwd } from 'src/utils/filesystem/cwd.js'
import {
  DEFAULT_OUTPUT_STYLE_NAME,
  getAllOutputStyles,
} from 'src/constants/outputStyles.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import { getAccountInformation } from 'src/utils/auth/auth.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import {
  registerHookCallbacks,
  setInitJsonSchema,
  setMainLoopModelOverride,
  setMainThreadAgentType,
  getMainThreadAgentType,
  getSessionId,
} from 'src/bootstrap/state.js'
import { parseUserSpecifiedModel } from 'src/utils/model/model.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import {
  getFastModeState,
  isFastModeAvailable,
  isFastModeEnabled,
} from 'src/utils/fastMode.js'
import { AwsAuthStatusManager } from 'src/utils/auth/awsAuthStatusManager.js'
import {
  fileHistoryCanRestore,
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
  fileHistoryRewind,
} from 'src/utils/filesystem/fileHistory.js'
import { errorMessage } from 'src/utils/errors.js'
import type { ToolPermissionContext } from 'src/Tool.js'
import type { PermissionMode as InternalPermissionMode } from 'src/types/permissions.js'
import {
  getAutoModeUnavailableNotification,
  getAutoModeUnavailableReason,
  isAutoModeGateEnabled,
  isBypassPermissionsModeDisabled,
  transitionPermissionMode,
} from 'src/utils/permissions/permissionSetup.js'

async function handleInitializeRequest(
  request: SDKControlInitializeRequest,
  requestId: string,
  initialized: boolean,
  output: Stream<StdoutMessage>,
  commands: Command[],
  modelInfos: ModelInfo[],
  structuredIO: StructuredIO,
  enableAuthStatus: boolean,
  options: {
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    agent?: string | undefined
    userSpecifiedModel?: string | undefined
    [key: string]: unknown
  },
  agents: AgentDefinition[],
  getAppState: () => AppState,
): Promise<void> {
  if (initialized) {
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        error: 'Already initialized',
        request_id: requestId,
        pending_permission_requests:
          structuredIO.getPendingPermissionRequests(),
      },
    })
    return
  }

  // Apply systemPrompt/appendSystemPrompt from stdin to avoid ARG_MAX limits
  if (request.systemPrompt !== undefined) {
    options.systemPrompt = request.systemPrompt
  }
  if (request.appendSystemPrompt !== undefined) {
    options.appendSystemPrompt = request.appendSystemPrompt
  }
  if (request.promptSuggestions !== undefined) {
    options.promptSuggestions = request.promptSuggestions
  }

  // Merge agents from stdin to avoid ARG_MAX limits
  if (request.agents) {
    const stdinAgents = parseAgentsFromJson(request.agents, 'flagSettings')
    agents.push(...stdinAgents)
  }

  // Re-evaluate main thread agent after SDK agents are merged
  // This allows --agent to reference agents defined via SDK
  if (options.agent) {
    // If main.tsx already found this agent (filesystem-defined), it already
    // applied systemPrompt/model/initialPrompt. Skip to avoid double-apply.
    const alreadyResolved = getMainThreadAgentType() === options.agent
    const mainThreadAgent = agents.find(a => a.agentType === options.agent)
    if (mainThreadAgent && !alreadyResolved) {
      // Update the main thread agent type in bootstrap state
      setMainThreadAgentType(mainThreadAgent.agentType)

      // Apply the agent's system prompt if user hasn't specified a custom one
      // SDK agents are always custom agents (not built-in), so getSystemPrompt() takes no args
      if (!options.systemPrompt && !isBuiltInAgent(mainThreadAgent)) {
        const agentSystemPrompt = mainThreadAgent.getSystemPrompt()
        if (agentSystemPrompt) {
          options.systemPrompt = agentSystemPrompt
        }
      }

      // Apply the agent's model if user didn't specify one and agent has a model
      if (
        !options.userSpecifiedModel &&
        mainThreadAgent.model &&
        mainThreadAgent.model !== 'inherit'
      ) {
        const agentModel = parseUserSpecifiedModel(mainThreadAgent.model)
        setMainLoopModelOverride(agentModel)
      }

      // SDK-defined agents arrive via init, so main.tsx's lookup missed them.
      if (mainThreadAgent.initialPrompt) {
        structuredIO.prependUserMessage(mainThreadAgent.initialPrompt)
      }
    } else if (mainThreadAgent?.initialPrompt) {
      // Filesystem-defined agent (alreadyResolved by main.tsx). main.tsx
      // handles initialPrompt for the string inputPrompt case, but when
      // inputPrompt is an AsyncIterable (SDK stream-json), it can't
      // concatenate — fall back to prependUserMessage here.
      structuredIO.prependUserMessage(mainThreadAgent.initialPrompt)
    }
  }

  const settings = getSettings_DEPRECATED()
  const outputStyle = settings?.outputStyle || DEFAULT_OUTPUT_STYLE_NAME
  const availableOutputStyles = await getAllOutputStyles(getCwd())

  // Get account information
  const accountInfo = getAccountInformation()
  if (request.hooks) {
    const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {}
    for (const [event, matchers] of Object.entries(request.hooks) as [
      string,
      Array<{ hookCallbackIds: string[]; timeout?: number; matcher?: string }>,
    ][]) {
      hooks[event as HookEvent] = matchers.map(matcher => {
        const callbacks = matcher.hookCallbackIds.map(callbackId => {
          return structuredIO.createHookCallback(callbackId, matcher.timeout)
        })
        return {
          matcher: matcher.matcher,
          hooks: callbacks,
        }
      })
    }
    registerHookCallbacks(hooks)
  }
  if (request.jsonSchema) {
    setInitJsonSchema(request.jsonSchema)
  }
  const initResponse: SDKControlInitializeResponse = {
    commands: commands
      .filter(cmd => cmd.userInvocable !== false)
      .map(cmd => ({
        name: getCommandName(cmd),
        description: formatDescriptionWithSource(cmd),
        argumentHint: cmd.argumentHint || '',
      })),
    agents: agents.map(agent => ({
      name: agent.agentType,
      description: agent.whenToUse,
      // 'inherit' is an internal sentinel; normalize to undefined for the public API
      model: agent.model === 'inherit' ? undefined : agent.model,
    })),
    output_style: outputStyle,
    available_output_styles: Object.keys(availableOutputStyles),
    models: modelInfos as unknown as SDKControlInitializeResponse['models'],
    account: {
      email: accountInfo?.email,
      organization: accountInfo?.organization,
      subscriptionType: accountInfo?.subscription,
      tokenSource: accountInfo?.tokenSource,
      apiKeySource: accountInfo?.apiKeySource,
      // getAccountInformation() returns undefined under 3P providers, so the
      // other fields are all absent. apiProvider disambiguates "not logged
      // in" (firstParty + tokenSource:none) from "3P, login not applicable".
      apiProvider: getAPIProvider() as
        | 'firstParty'
        | 'bedrock'
        | 'vertex'
        | 'foundry',
    },
    pid: process.pid,
  }

  if (isFastModeEnabled() && isFastModeAvailable()) {
    const appState = getAppState()
    initResponse.fast_mode_state = getFastModeState(
      options.userSpecifiedModel ?? null,
      appState.fastMode,
    )
  }

  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: initResponse,
    },
  })

  // After the initialize message, check the auth status-
  // This will get notified of changes, but we also want to send the
  // initial state.
  if (enableAuthStatus) {
    const authStatusManager = AwsAuthStatusManager.getInstance()
    const status = authStatusManager.getStatus()
    if (status) {
      output.enqueue({
        type: 'auth_status',
        isAuthenticating: status.isAuthenticating,
        output: status.output,
        error: status.error,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  }
}

async function handleRewindFiles(
  userMessageId: UUID,
  appState: AppState,
  setAppState: (updater: (prev: AppState) => AppState) => void,
  dryRun: boolean,
): Promise<RewindFilesResult> {
  if (!fileHistoryEnabled()) {
    return {
      canRewind: false,
      error: 'File rewinding is not enabled.',
      filesChanged: [],
    }
  }
  if (!fileHistoryCanRestore(appState.fileHistory, userMessageId)) {
    return {
      canRewind: false,
      error: 'No file checkpoint found for this message.',
      filesChanged: [],
    }
  }

  if (dryRun) {
    const diffStats = await fileHistoryGetDiffStats(
      appState.fileHistory,
      userMessageId,
    )
    return {
      canRewind: true,
      filesChanged: diffStats?.filesChanged ?? [],
      insertions: diffStats?.insertions,
      deletions: diffStats?.deletions,
    }
  }

  try {
    await fileHistoryRewind(
      updater =>
        setAppState(prev => ({
          ...prev,
          fileHistory: updater(prev.fileHistory),
        })),
      userMessageId,
    )
  } catch (error) {
    return {
      canRewind: false,
      error: `Failed to rewind: ${errorMessage(error)}`,
      filesChanged: [],
    }
  }

  return { canRewind: true, filesChanged: [] }
}

function handleSetPermissionMode(
  request: { mode: InternalPermissionMode },
  requestId: string,
  toolPermissionContext: ToolPermissionContext,
  output: Stream<StdoutMessage>,
): ToolPermissionContext {
  // Check if trying to switch to bypassPermissions mode
  if (request.mode === 'bypassPermissions') {
    if (isBypassPermissionsModeDisabled()) {
      output.enqueue({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error:
            'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration',
        },
      })
      return toolPermissionContext
    }
    if (!toolPermissionContext.isBypassPermissionsModeAvailable) {
      output.enqueue({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error:
            'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions',
        },
      })
      return toolPermissionContext
    }
  }

  // Check if trying to switch to auto mode without the classifier gate
  if (
    feature('TRANSCRIPT_CLASSIFIER') &&
    request.mode === 'auto' &&
    !isAutoModeGateEnabled()
  ) {
    const reason = getAutoModeUnavailableReason()
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error: reason
          ? `Cannot set permission mode to auto: ${getAutoModeUnavailableNotification(reason)}`
          : 'Cannot set permission mode to auto',
      },
    })
    return toolPermissionContext
  }

  // Allow the mode switch
  output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        mode: request.mode,
      },
    },
  })

  return {
    ...transitionPermissionMode(
      toolPermissionContext.mode,
      request.mode,
      toolPermissionContext,
    ),
    mode: request.mode,
  }
}

export { handleInitializeRequest, handleRewindFiles, handleSetPermissionMode }
