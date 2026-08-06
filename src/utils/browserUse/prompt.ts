import { BROWSER_USE_TOOL_PREFIX } from './common.js'

/**
 * Appended to the system prompt when browser-use is the active backend.
 *
 * Deliberately short, for the same reason as the Chrome DevTools prompt: the
 * tool schemas already describe each tool. What the model cannot see from the
 * schemas is that these drive a real browser, that most of them will stop and
 * ask first, and that one of them is itself an autonomous agent.
 */
export const BROWSER_USE_SYSTEM_PROMPT = `# Browser tools (browser-use)

browser-use tools are connected this session as \`${BROWSER_USE_TOOL_PREFIX}*\`. They drive a real browser: you can read page state, extract content, navigate, click, type, scroll, and manage tabs and sessions.

Three things about this browser:

- It is a real browser session, potentially with the user's logins. Treat every page as production. Do not sign anything out, submit destructive forms, or change account settings unless the user asked for exactly that.
- Only read-only tools run unprompted. Anything that navigates, clicks, types, or closes a tab or session is permission-gated and the user will be asked to approve it. Expect that pause; it is not an error.
- \`${BROWSER_USE_TOOL_PREFIX}retry_with_browser_use_agent\` hands the task to a separate autonomous agent that will act on its own for many steps. Reach for it only when step-by-step control has actually failed — it costs its own model calls and you cannot see what it does mid-flight.

Working effectively:

1. Start with \`${BROWSER_USE_TOOL_PREFIX}browser_get_state\` to see what is on the page and what is interactable. The state names elements by index — interaction tools take that index, not a CSS selector.
2. Use \`${BROWSER_USE_TOOL_PREFIX}browser_extract_content\` when you want the page's information rather than its structure; it is far cheaper than reasoning over raw state.
3. After an action that changes the page, read state again — indices go stale.
4. When something fails twice in a row, stop and report what you saw instead of retrying variations.`

/** The prompt section appended when the browser-use server is enabled. */
export function getBrowserUseSystemPrompt(): string {
  return BROWSER_USE_SYSTEM_PROMPT
}

/**
 * Extra instructions for when tool search is on. MCP tools are deferred-loading
 * under SearchExtraTools, so the model has to discover them before it can call
 * them — without this it reports "I don't have browser tools" while the server
 * sits connected.
 */
export const BROWSER_USE_SEARCH_EXTRA_TOOLS_INSTRUCTIONS = `**IMPORTANT: Before using any browser tools, you MUST first load them using SearchExtraTools.**

browser-use tools are MCP tools that require loading before use. Before calling any \`${BROWSER_USE_TOOL_PREFIX}\` tool:
1. Use SearchExtraTools with \`select:${BROWSER_USE_TOOL_PREFIX}<tool_name>\` to load the specific tool
2. Then call the tool

For example, to read the current page:
1. First: SearchExtraTools with query "select:${BROWSER_USE_TOOL_PREFIX}browser_get_state"
2. Then: Call ${BROWSER_USE_TOOL_PREFIX}browser_get_state`
