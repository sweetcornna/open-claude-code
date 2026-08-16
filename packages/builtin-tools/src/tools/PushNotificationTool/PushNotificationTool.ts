import { z } from 'zod/v4'
import {
  buildTool,
  type ToolResultBlockParam,
} from '@open-claude-code/tool-runtime/Tool.js'
import { lazySchema } from '@open-claude-code/tool-runtime/lazySchema.js'
import {
  isRemoteControlEnabled,
  sendRemoteControlPushNotification,
} from '@open-claude-code/tool-runtime/remoteControl.js'

const PUSH_NOTIFICATION_TOOL_NAME = 'PushNotification'

const inputSchema = lazySchema(() =>
  z.strictObject({
    title: z.string().describe('Title of the push notification.'),
    body: z.string().describe('Body text of the push notification.'),
    priority: z
      .enum(['normal', 'high'])
      .optional()
      .describe(
        'Notification priority. Use "high" for blockers or permission prompts.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type PushInput = z.infer<InputSchema>
type PushOutput = { sent: boolean }

export const PushNotificationTool = buildTool({
  name: PUSH_NOTIFICATION_TOOL_NAME,
  searchHint: 'push notification mobile alert notify user',
  maxResultSizeChars: 1_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return "Send a push notification to the user's mobile device"
  },
  async prompt() {
    return `Send a push notification to the user's mobile device via Remote Control.

Use this when:
- A long-running task completes and the user may not be watching
- A permission prompt is waiting and you need user input
- Something urgent requires the user's attention

Requires Remote Control to be configured. Respects user notification settings (taskCompleteNotifEnabled, inputNeededNotifEnabled, agentPushNotifEnabled).`
  },

  isEnabled() {
    return isRemoteControlEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  userFacingName() {
    return 'Notify'
  },

  renderToolUseMessage(input: Partial<PushInput>) {
    return `Push: ${input.title ?? '...'}`
  },

  mapToolResultToToolResultBlockParam(
    content: PushOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: content.sent
        ? 'Notification sent.'
        : 'Failed to send notification.',
    }
  },

  async call(input: PushInput, context) {
    const appState = context.getAppState()
    const sent = appState.replBridgeEnabled
      ? await sendRemoteControlPushNotification({
          title: input.title,
          body: input.body,
          priority: input.priority ?? 'normal',
        })
      : false

    return {
      data: sent
        ? { sent: true }
        : {
            sent: false,
            error:
              'No Remote Control bridge configured. Notification not delivered.',
          },
    }
  },
})
