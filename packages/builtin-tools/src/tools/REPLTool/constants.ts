// Pure leaf: tool names and static strings only. See BashTool/constants.ts.
//
// isReplModeEnabled() used to live here; it needs src/utils/envUtils.js and
// moved to replMode.ts.
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/constants.js'
import { GLOB_TOOL_NAME } from '../GlobTool/constants.js'
import { GREP_TOOL_NAME } from '../GrepTool/constants.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/constants.js'

export const REPL_TOOL_NAME = 'REPL'

/**
 * Tools that are only accessible via REPL when REPL mode is enabled.
 * When REPL mode is on, these tools are hidden from Claude's direct use,
 * forcing Claude to use REPL for batch operations.
 */
export const REPL_ONLY_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  BASH_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  AGENT_TOOL_NAME,
])
