import {
  CHROME_BROWSER_URL_ENV,
  CHROME_DEVTOOLS_TOOL_PREFIX,
} from './common.js'

/**
 * Appended to the system prompt when `--chrome` is active.
 *
 * Deliberately short. The tool schemas from chrome-devtools-mcp already
 * describe each tool; what the model cannot see from the schemas is that these
 * tools drive the *user's own* browser and that most of them will stop and ask
 * before running.
 */
export const CHROME_DEVTOOLS_SYSTEM_PROMPT = `# Browser tools (Chrome DevTools)

Chrome DevTools tools are connected this session as \`${CHROME_DEVTOOLS_TOOL_PREFIX}*\`. They drive a real Chrome browser over the DevTools protocol: you can list and select pages, take accessibility snapshots and screenshots, read console messages and network requests, run Lighthouse audits and performance traces, and click, type, and navigate.

Two things about this browser:

- It is usually the user's own Chrome, with their real profile and their live logins. Treat every page as production. Do not sign anything out, submit destructive forms, or change account settings unless the user asked for exactly that.
- Only read-only tools run unprompted. Anything that navigates, clicks, types, uploads, evaluates script, or reloads the page is permission-gated and the user will be asked to approve it. Expect that pause; it is not an error.

Working effectively:

1. Start with \`${CHROME_DEVTOOLS_TOOL_PREFIX}list_pages\` to see what is open, then \`${CHROME_DEVTOOLS_TOOL_PREFIX}take_snapshot\` on the page you care about. The snapshot is a text accessibility tree with a \`uid\` per element — interaction tools take that \`uid\`, not a CSS selector.
2. Prefer \`take_snapshot\` over \`take_screenshot\` for finding elements; screenshots are for showing the user what something looks like.
3. After an action that changes the page, take a fresh snapshot — old \`uid\`s go stale.
4. When something fails twice in a row, stop and report what you saw instead of retrying variations. Read the console and network output first; it usually names the cause.

If the tools are not connected, the user can enable them by restarting with \`--chrome\`, or set \`${CHROME_BROWSER_URL_ENV}\` when Chrome runs on another host (WSL, a remote desktop, or a container).`

/** The prompt section appended when the Chrome DevTools server is enabled. */
export function getChromeDevtoolsSystemPrompt(): string {
  return CHROME_DEVTOOLS_SYSTEM_PROMPT
}

/**
 * Extra instructions for when tool search is on. MCP tools are deferred-loading
 * under SearchExtraTools, so the model has to discover them before it can call
 * them — without this it reports "I don't have browser tools" while the server
 * sits connected.
 *
 * Injected only when tool search is actually enabled, not optimistically:
 * appending it per-request would bust the prompt cache every time Chrome
 * connects late in a session.
 */
export const CHROME_DEVTOOLS_SEARCH_EXTRA_TOOLS_INSTRUCTIONS = `**IMPORTANT: Before using any Chrome browser tools, you MUST first load them using SearchExtraTools.**

Chrome DevTools tools are MCP tools that require loading before use. Before calling any \`${CHROME_DEVTOOLS_TOOL_PREFIX}\` tool:
1. Use SearchExtraTools with \`select:${CHROME_DEVTOOLS_TOOL_PREFIX}<tool_name>\` to load the specific tool
2. Then call the tool

For example, to see the open pages:
1. First: SearchExtraTools with query "select:${CHROME_DEVTOOLS_TOOL_PREFIX}list_pages"
2. Then: Call ${CHROME_DEVTOOLS_TOOL_PREFIX}list_pages`
