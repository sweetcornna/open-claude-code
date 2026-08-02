import type { ScrollBoxHandle } from '@anthropic/ink'
import type { MCPServerConnection } from '../../services/mcp/types.js'

// Stable empty array for hooks that accept MCPServerConnection[] — avoids
// creating a new [] literal on every render in remote mode, which would
// cause useEffect dependency changes and infinite re-render loops.
export const EMPTY_MCP_CLIENTS: MCPServerConnection[] = []

// Stable stub for useAssistantHistory's non-KAIROS branch — avoids a new
// function identity each render, which would break composedOnScroll's memo.
export const HISTORY_STUB = { maybeLoadOlder: (_: ScrollBoxHandle) => {} }
// Window after a user-initiated scroll during which type-into-empty does NOT
// repin to bottom. Josh Rosen's workflow: Claude emits long output → scroll
// up to read the start → start typing → before this fix, snapped to bottom.
// https://anthropic.slack.com/archives/C07VBSHV7EV/p1773545449871739
export const RECENT_SCROLL_REPIN_WINDOW_MS = 3000
