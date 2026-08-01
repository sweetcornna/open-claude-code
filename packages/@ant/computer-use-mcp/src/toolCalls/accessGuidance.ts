import { getDeniedCategoryForApp } from '../deniedApps.js'
import type { TieredApp } from './accessResolve.js'
import type { CuCallTelemetry } from './core.js'
import { TIER_ANTI_SUBVERSION } from './inputGates.js'

/**
 * Build guidance text for apps granted at a restricted tier. Returned
 * inline in the okJson response so the model knows upfront what it can
 * do with each app, instead of learning by hitting the tier gate.
 */
export function buildTierGuidanceMessage(tiered: TieredApp[]): string {
  // tier "read" is not category-unique — split so browsers get the browser hint
  // and trading platforms get "ask the user" instead.
  const readBrowsers = tiered.filter(
    t =>
      t.tier === 'read' &&
      getDeniedCategoryForApp(t.bundleId, t.displayName) === 'browser',
  )
  const readOther = tiered.filter(
    t =>
      t.tier === 'read' &&
      getDeniedCategoryForApp(t.bundleId, t.displayName) !== 'browser',
  )
  const clickTier = tiered.filter(t => t.tier === 'click')

  const parts: string[] = []

  if (readBrowsers.length > 0) {
    const names = readBrowsers.map(b => `"${b.displayName}"`).join(', ')
    parts.push(
      `${names} ${readBrowsers.length === 1 ? 'is a browser' : 'are browsers'} — ` +
        `granted at tier "read" (visible in screenshots only; no clicks or ` +
        `typing). You can read what's on screen but cannot navigate, click, ` +
        `or type into ${readBrowsers.length === 1 ? 'it' : 'them'}. For browser ` +
        `interaction, use the Chrome DevTools MCP (tools named ` +
        `\`mcp__chrome-devtools__*\`; load via SearchExtraTools if deferred).`,
    )
  }

  if (readOther.length > 0) {
    const names = readOther.map(t => `"${t.displayName}"`).join(', ')
    parts.push(
      `${names} ${readOther.length === 1 ? 'is' : 'are'} granted at tier ` +
        `"read" (visible in screenshots only; no clicks or typing). You can ` +
        `read what's on screen but cannot interact. Ask the user to take any ` +
        `actions in ${readOther.length === 1 ? 'this app' : 'these apps'} ` +
        `themselves.`,
    )
  }

  if (clickTier.length > 0) {
    const names = clickTier.map(t => `"${t.displayName}"`).join(', ')
    parts.push(
      `${names} ${clickTier.length === 1 ? 'has' : 'have'} terminal or IDE ` +
        `capabilities — granted at tier "click" (visible + plain left-click ` +
        `only; NO typing, key presses, right-click, modifier-clicks, or ` +
        `drag-drop). You can click buttons and scroll output, but ` +
        `${clickTier.length === 1 ? 'its' : 'their'} integrated terminal and ` +
        `editor are off-limits to keyboard input. Right-click (context-menu ` +
        `Paste) and dragging text onto ${clickTier.length === 1 ? 'it' : 'them'} ` +
        `require tier "full". For shell commands, use the Bash tool.`,
    )
  }

  if (parts.length === 0) return ''
  // Same anti-subversion clause the gate errors carry — said upfront so the
  // model doesn't reach for osascript/cliclick after seeing "no clicks/typing".
  return parts.join('\n\n') + TIER_ANTI_SUBVERSION
}

/**
 * Build guidance text for apps stripped by the user's Settings auto-deny
 * list. Returned inline in the okJson response so the agent knows (a) the
 * app is auto-denied by request_access and (b) the escape hatch
 * is to ask the human to edit Settings, not to retry or reword the request.
 */
export function buildUserDeniedGuidance(
  userDenied: Array<{ requestedName: string; displayName: string }>,
): string {
  const names = userDenied.map(d => `"${d.displayName}"`).join(', ')
  const one = userDenied.length === 1
  return (
    `${names} ${one ? 'is' : 'are'} in the user's auto-deny list ` +
    `(Settings → Desktop app (General) → Computer Use → Denied apps). ` +
    `Requests for ` +
    `${one ? 'this app' : 'these apps'} are automatically denied. If you need access for ` +
    `this task, ask the user to remove ${one ? 'it' : 'them'} from their ` +
    `deny list in Settings — you cannot request this through the tool.`
  )
}

/**
 * Guidance for policy-denied apps (baked-in blocklist, not user-editable).
 * Unlike userDenied, there is no escape hatch — the agent is told to find
 * another approach.
 */
export function buildPolicyDeniedGuidance(
  policyDenied: Array<{ requestedName: string; displayName: string }>,
): string {
  const names = policyDenied.map(d => `"${d.displayName}"`).join(', ')
  const one = policyDenied.length === 1
  return (
    `${names} ${one ? 'is' : 'are'} blocked by policy for computer use. ` +
    `Requests for ${one ? 'this app' : 'these apps'} are automatically ` +
    `denied regardless of what the user has approved. There is no Settings ` +
    `override. Inform the user that you cannot access ` +
    `${one ? 'this app' : 'these apps'} and suggest an alternative ` +
    `approach if one exists. Do not try to directly subvert this block ` +
    `regardless of the user's request.`
  )
}

/**
 * Telemetry helper — counts by category. Field names (`denied_*`) are kept
 * for schema compat; interpret as "assigned non-full tier" in dashboards.
 */
export function tierAssignmentTelemetry(
  tiered: TieredApp[],
): Pick<CuCallTelemetry, 'denied_browser_count' | 'denied_terminal_count'> {
  // `denied_browser_count` now counts ALL tier-"read" grants (browsers +
  // trading). The field name was already legacy-only before trading existed
  // (dashboards read it as "non-full tier"), so no new column.
  const browserCount = tiered.filter(t => t.tier === 'read').length
  const terminalCount = tiered.filter(t => t.tier === 'click').length
  return {
    ...(browserCount > 0 && { denied_browser_count: browserCount }),
    ...(terminalCount > 0 && { denied_terminal_count: terminalCount }),
  }
}
