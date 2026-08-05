import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '@open-claude-code/tool-runtime/Tool.js'
import {
  executeTaskCreatedHooks,
  getTaskCreatedHookMessage,
} from 'src/utils/hooks.js'
import { lazySchema } from '@open-claude-code/tool-runtime/lazySchema.js'
import {
  createTask,
  deleteTask,
  getTaskAgentTag,
  getTaskListId,
  isTodoV2Enabled,
  stripAgentTag,
  TASK_AGENT_ID_METADATA_KEY,
} from 'src/utils/task/tasks.js'
import { getAgentName, getTeamName } from 'src/utils/agents/teammate.js'
import { TASK_CREATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    subject: z.string().describe('A brief title for the task'),
    description: z.string().describe('What needs to be done'),
    activeForm: z
      .string()
      .optional()
      .describe(
        'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
      ),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Arbitrary metadata to attach to the task'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    task: z.object({
      id: z.string(),
      subject: z.string(),
    }),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const TaskCreateTool = buildTool({
  name: TASK_CREATE_TOOL_NAME,
  searchHint: 'create a task in the task list',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'TaskCreate'
  },
  shouldDefer: true,
  isEnabled() {
    return isTodoV2Enabled()
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.subject
  },
  renderToolUseMessage() {
    return null
  },
  async call({ subject, description, activeForm, metadata }, context) {
    const taskListId = getTaskListId()

    // Tag tasks a subagent creates for itself so the main session's todo UI,
    // reminders and TaskList don't absorb the subagent's private breakdown.
    // Returns undefined on the main thread and on shared/team task lists,
    // where the list is meant to be common ground.
    //
    // `metadata` is a model-controlled z.record, so the incoming bag is
    // stripped of `_agentId` first: without that, a model could hide any
    // main-thread task from the user permanently by forging the key.
    const agentTag = getTaskAgentTag(context.agentId)
    const hostOwnedMetadata = stripAgentTag(metadata)
    const taskMetadata = agentTag
      ? { ...hostOwnedMetadata, [TASK_AGENT_ID_METADATA_KEY]: agentTag }
      : hostOwnedMetadata

    const taskId = await createTask(taskListId, {
      subject,
      description,
      activeForm,
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
      metadata: taskMetadata,
    })

    const blockingErrors: string[] = []
    const generator = executeTaskCreatedHooks(
      taskId,
      subject,
      description,
      getAgentName(),
      getTeamName(),
      undefined,
      context?.abortController?.signal,
      undefined,
      context,
    )
    for await (const result of generator) {
      if (result.blockingError) {
        blockingErrors.push(getTaskCreatedHookMessage(result.blockingError))
      }
    }

    if (blockingErrors.length > 0) {
      await deleteTask(taskListId, taskId)
      throw new Error(blockingErrors.join('\n'))
    }

    // Auto-expand task list when creating tasks
    context.setAppState(prev => {
      if (prev.expandedView === 'tasks') return prev
      return { ...prev, expandedView: 'tasks' as const }
    })

    return {
      data: {
        task: {
          id: taskId,
          subject,
        },
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { task } = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Task #${task.id} created successfully: ${task.subject}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
