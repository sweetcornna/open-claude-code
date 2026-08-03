import { getSystemPrompt } from '../../constants/prompts.js'
import { buildEffectiveSystemPrompt } from '../../utils/session/systemPrompt.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { getQuerySourceForREPL } from '../../utils/text/promptCategory.js'
import {
  enqueuePendingNotification,
  removeByFilter,
  type SetAppState,
} from '../../utils/session/messageQueueManager.js'
import { startBackgroundSession } from '../../tasks/LocalMainSessionTask.js'
import {
  createAttachmentMessage,
  getQueuedCommandAttachments,
} from '../../utils/attachments.js'
import type { Message as MessageType } from '../../types/message.js'
import type { ProcessUserInputContext } from '../../utils/processUserInput/processUserInput.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type useCanUseTool from '../../hooks/useCanUseTool.js'
import type { AgentDefinition } from '@open-claude-code/builtin-tools/tools/AgentTool/loadAgentsDir.js'
import { logError } from '../../utils/telemetry/log.js'
import { toError } from '../../utils/runtime/errors.js'

/** Everything REPL's `handleBackgroundQuery` closure captured. */
export type BackgroundQueryContext = {
  abortController: AbortController | null
  appendSystemPrompt: string | undefined
  canUseTool: ReturnType<typeof useCanUseTool>
  customSystemPrompt: string | undefined
  getToolUseContext: (
    messages: MessageType[],
    newMessages: MessageType[],
    abortController: AbortController,
    mainLoopModel: string,
  ) => ProcessUserInputContext
  mainLoopModel: string
  mainThreadAgentDefinition: AgentDefinition | undefined
  messagesRef: { current: MessageType[] }
  setAppState: SetAppState
  terminalTitle: string
  toolPermissionContext: ToolPermissionContext
}

/**
 * Body of REPL's `handleBackgroundQuery` useCallback, moved out verbatim. The
 * useCallback wrapper and its dep array stay in REPL.tsx, so the hook call
 * order is untouched; the context object is built inside the callback so every
 * field resolves to the same closure variable the inline body captured.
 */
export function runBackgroundQuery(ctx: BackgroundQueryContext): void {
  const {
    abortController,
    appendSystemPrompt,
    canUseTool,
    customSystemPrompt,
    getToolUseContext,
    mainLoopModel,
    mainThreadAgentDefinition,
    messagesRef,
    setAppState,
    terminalTitle,
    toolPermissionContext,
  } = ctx

  void (async () => {
    let removedNotifications: ReturnType<typeof removeByFilter> = []
    try {
      // Prompt/context construction can touch settings, MCP state, and disk.
      // Finish it before aborting the foreground query so preparation failure
      // leaves the existing session and its notifications intact.
      const toolUseContext = getToolUseContext(
        messagesRef.current,
        [],
        new AbortController(),
        mainLoopModel,
      )

      const [defaultSystemPrompt, userContext, systemContext] =
        await Promise.all([
          getSystemPrompt(
            toolUseContext.options.tools,
            mainLoopModel,
            Array.from(
              toolPermissionContext.additionalWorkingDirectories.keys(),
            ),
            toolUseContext.options.mcpClients,
          ),
          getUserContext(),
          getSystemContext(),
        ])

      const systemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt,
      })
      toolUseContext.renderedSystemPrompt = systemPrompt

      // Commit only after preparation succeeds. Notifications produced by the
      // abort are included in the same transfer.
      abortController?.abort('background')
      removedNotifications = removeByFilter(
        cmd => cmd.mode === 'task-notification',
      )

      const notificationAttachments =
        await getQueuedCommandAttachments(removedNotifications)
      const notificationMessages = notificationAttachments.map(
        createAttachmentMessage,
      )

      // Deduplicate: if the query loop already yielded a notification into
      // messagesRef before we removed it from the queue, skip duplicates.
      // We use prompt text for dedup because source_uuid is not set on
      // task-notification QueuedCommands (enqueuePendingNotification callers
      // don't pass uuid), so it would always be undefined.
      const existingPrompts = new Set<string>()
      for (const m of messagesRef.current) {
        if (
          m.type === 'attachment' &&
          m.attachment!.type === 'queued_command' &&
          m.attachment!.commandMode === 'task-notification' &&
          typeof m.attachment!.prompt === 'string'
        ) {
          existingPrompts.add(m.attachment!.prompt)
        }
      }
      const uniqueNotifications = notificationMessages.filter(
        m =>
          m.attachment.type === 'queued_command' &&
          (typeof m.attachment.prompt !== 'string' ||
            !existingPrompts.has(m.attachment.prompt)),
      )

      startBackgroundSession({
        messages: [...messagesRef.current, ...uniqueNotifications],
        queryParams: {
          systemPrompt,
          userContext,
          systemContext,
          canUseTool,
          toolUseContext,
          querySource: getQuerySourceForREPL(),
        },
        description: terminalTitle,
        setAppState,
        agentDefinition: mainThreadAgentDefinition,
      })
    } catch (error: unknown) {
      // Once the commit boundary has been crossed, queue restoration is the
      // only way to keep task completions visible to the foreground session.
      for (const notification of removedNotifications) {
        enqueuePendingNotification(notification)
      }
      logError(toError(error))
    }
  })()
}
