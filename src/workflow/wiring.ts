import {
  createWorkflowTool,
  workflowInputSchema,
  WORKFLOW_TOOL_NAME,
  type WorkflowInput,
  type WorkflowRunInput,
  type WorkflowToolDescriptor,
} from '@open-claude-code/workflow-engine'
import { buildTool, type Tool } from '../Tool.js'
import type { PermissionResult } from '../utils/permissions/PermissionResult.js'
import { getRuleByContentsForToolName } from '../utils/permissions/contentRuleLookup.js'
import {
  getWorkflowService,
  OCC_WORKFLOW_DIR,
  OCC_WORKFLOW_RUNS_DIR,
  workflowDefaultMaxConcurrency,
} from './service.js'

/**
 * Adapts the engine's self-contained descriptor into a buildTool-compatible Tool.
 * The descriptor routes through the service singleton (sharing ports/registry/store).
 *
 * ports resolution is deferred to the first real method call (lazy): tools.ts calls
 * createWorkflowToolCore() during module-load (feature-gated), and resolving ports
 * immediately would trigger service instantiation, which in turn calls module-level
 * side effects like getProjectRoot — yielding wrong paths before bootstrap completes.
 * The Tool object itself is a singleton via createWorkflowToolCore's cached (PermissionRequest
 * matches by reference), and the ports singleton is guaranteed by getWorkflowService.
 */
async function workflowPermissionResult(
  input: WorkflowInput,
  context: Parameters<Tool['checkPermissions']>[1],
): Promise<PermissionResult> {
  if (input.operation === 'status' || input.operation === 'query') {
    return { behavior: 'allow', updatedInput: input }
  }

  if (input.operation === 'cancel') {
    return {
      behavior: 'ask',
      message: 'Review workflow cancellation',
      updatedInput: input,
    }
  }

  const runInput = input as WorkflowRunInput
  const workflowName =
    runInput.script === undefined && runInput.scriptPath === undefined
      ? runInput.name
      : undefined
  if (workflowName) {
    const permissionContext = context.getAppState().toolPermissionContext
    for (const behavior of ['deny', 'ask', 'allow'] as const) {
      const rule = getRuleByContentsForToolName(
        permissionContext,
        WORKFLOW_TOOL_NAME,
        behavior,
      ).get(workflowName)
      if (!rule) continue
      if (behavior === 'deny') {
        return {
          behavior: 'deny',
          message: `Workflow ${workflowName} blocked by permission rules`,
          decisionReason: { type: 'rule', rule },
        }
      }
      if (behavior === 'ask') {
        return {
          behavior: 'ask',
          message: 'Review dynamic workflow before running',
          updatedInput: input,
          decisionReason: { type: 'rule', rule },
        }
      }
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'rule', rule },
      }
    }
  }

  return {
    behavior: 'ask',
    message: 'Review dynamic workflow before running',
    updatedInput: input,
    ...(workflowName
      ? {
          suggestions: [
            {
              type: 'addRules' as const,
              rules: [
                { toolName: WORKFLOW_TOOL_NAME, ruleContent: workflowName },
              ],
              behavior: 'allow' as const,
              destination: 'localSettings' as const,
            },
          ],
        }
      : {}),
  }
}

function buildWorkflowTool(): Tool {
  let cachedDescriptor: WorkflowToolDescriptor | null = null
  const descriptor = (): WorkflowToolDescriptor => {
    if (!cachedDescriptor) {
      const { ports } = getWorkflowService()
      const envConcurrency = workflowDefaultMaxConcurrency()
      cachedDescriptor = createWorkflowTool(ports, {
        workflowDir: OCC_WORKFLOW_DIR,
        workflowRunsDir: OCC_WORKFLOW_RUNS_DIR,
        // Resolved here rather than inside the engine (which reads no process.env).
        // Read once with the rest of the descriptor: this whole object is built lazily
        // on first tool use, long after startup, so the env is settled by then.
        ...(envConcurrency !== undefined
          ? { defaultMaxConcurrency: envConcurrency }
          : {}),
      })
    }
    return cachedDescriptor
  }
  return buildTool({
    name: WORKFLOW_TOOL_NAME,
    maxResultSizeChars: 50_000,
    inputSchema: workflowInputSchema,
    isEnabled: () => descriptor().isEnabled(),
    isReadOnly: input => descriptor().isReadOnly(input),
    isConcurrencySafe: () => true,
    checkPermissions: workflowPermissionResult,
    async description() {
      return descriptor().description()
    },
    async prompt() {
      return descriptor().prompt()
    },
    async call(input, context, canUseTool, parentMessage, onProgress) {
      const result = await descriptor().call(
        input,
        context,
        canUseTool,
        parentMessage,
        onProgress,
      )
      return { data: result.data }
    },
    renderToolUseMessage: input => descriptor().renderToolUseMessage(input),
    mapToolResultToToolResultBlockParam: (data, toolUseId) =>
      descriptor().mapToolResultToToolResultBlockParam(data, toolUseId),
  })
}

// Singleton: tools.ts registration and PermissionRequest must reference the same instance (switch matches by reference).
let cached: Tool | null = null

export function createWorkflowToolCore(): Tool {
  if (!cached) cached = buildWorkflowTool()
  return cached
}
