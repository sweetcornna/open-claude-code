/**
 * Re-export barrel for the Tool contract.
 *
 * The contract itself lives in `@open-claude-code/tool-runtime/Tool.js`
 * (wave B of the tool-runtime dependency inversion). This file stays behind
 * so the ~150 host-side `src/Tool.js` importers keep working unchanged, and
 * so `mock.module('src/Tool.js')` in existing tests still resolves.
 *
 * The re-exports are explicit rather than `export *`: the surface is pinned
 * by src/__tests__/Tool.surface.test.ts, which reads this file's AST, so an
 * accidentally dropped name fails loudly instead of only at some distant
 * call site.
 */

export type {
  AnyObject,
  CompactProgressEvent,
  Progress,
  QueryChainTracking,
  SetToolJSXFn,
  Tool,
  ToolCallProgress,
  ToolDef,
  ToolInputJSONSchema,
  ToolPermissionContext,
  ToolPermissionRulesBySource,
  ToolProgress,
  ToolProgressData,
  ToolResult,
  ToolResultBlockParam,
  Tools,
  ToolUseContext,
  ValidationResult,
} from '@open-claude-code/tool-runtime/Tool.js'

export {
  buildTool,
  filterToolProgressMessages,
  findToolByName,
  getEmptyToolPermissionContext,
  toolMatchesName,
} from '@open-claude-code/tool-runtime/Tool.js'
