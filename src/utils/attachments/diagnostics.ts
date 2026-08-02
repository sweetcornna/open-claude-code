import { toolMatchesName, type ToolUseContext } from '../../Tool.js'
import { BASH_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/BashTool/toolName.js'
import { diagnosticTracker } from '../../services/diagnosticTracking.js'
import {
  checkForLSPDiagnostics,
  clearAllLSPDiagnostics,
} from '../../services/lsp/LSPDiagnosticRegistry.js'
import { logError } from '../telemetry/log.js'
import { logForDebugging } from '../telemetry/debug.js'
import { toError } from '../runtime/errors.js'
import type { Attachment } from './types.js'

export async function getDiagnosticAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // Diagnostics are only useful if the agent has the Bash tool to act on them
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))
  ) {
    return []
  }

  // Get new diagnostics from the tracker (IDE diagnostics via MCP)
  const newDiagnostics = await diagnosticTracker.getNewDiagnostics()
  if (newDiagnostics.length === 0) {
    return []
  }

  return [
    {
      type: 'diagnostics',
      files: newDiagnostics,
      isNew: true,
    },
  ]
}

/**
 * Get LSP diagnostic attachments from passive LSP servers.
 * Follows the AsyncHookRegistry pattern for consistent async attachment delivery.
 */
export async function getLSPDiagnosticAttachments(
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  // LSP diagnostics are only useful if the agent has the Bash tool to act on them
  if (
    !toolUseContext.options.tools.some(t => toolMatchesName(t, BASH_TOOL_NAME))
  ) {
    return []
  }

  logForDebugging('LSP Diagnostics: getLSPDiagnosticAttachments called')

  try {
    const diagnosticSets = checkForLSPDiagnostics()

    if (diagnosticSets.length === 0) {
      return []
    }

    logForDebugging(
      `LSP Diagnostics: Found ${diagnosticSets.length} pending diagnostic set(s)`,
    )

    // Convert each diagnostic set to an attachment
    const attachments: Attachment[] = diagnosticSets.map(({ files }) => ({
      type: 'diagnostics' as const,
      files,
      isNew: true,
    }))

    // Clear delivered diagnostics from registry to prevent memory leak
    // Follows same pattern as removeDeliveredAsyncHooks
    if (diagnosticSets.length > 0) {
      clearAllLSPDiagnostics()
      logForDebugging(
        `LSP Diagnostics: Cleared ${diagnosticSets.length} delivered diagnostic(s) from registry`,
      )
    }

    logForDebugging(
      `LSP Diagnostics: Returning ${attachments.length} diagnostic attachment(s)`,
    )

    return attachments
  } catch (error) {
    const err = toError(error)
    logError(
      new Error(`Failed to get LSP diagnostic attachments: ${err.message}`),
    )
    // Return empty array to allow other attachments to proceed
    return []
  }
}
