import type { ComputerExecutor } from '../executor.js'
import type { ComputerUseHostAdapter, ComputerUseOverrides } from '../types.js'
import { looksLikeBundleId } from './accessResolve.js'
import { errorResult, okJson, okText, requireString } from './core.js'
import type { CuCallToolResult } from './core.js'

export async function handleOpenApplication(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  const app = requireString(args, 'app')
  if (app instanceof Error) return errorResult(app.message, 'bad_args')

  // Resolve display-name → bundle ID. Same logic as request_access.
  const allowed = new Set(overrides.allowedApps.map(g => g.bundleId))
  let targetBundleId: string | undefined

  if (looksLikeBundleId(app) && allowed.has(app)) {
    targetBundleId = app
  } else {
    // Try display name → bundle ID, but ONLY against the allowlist itself.
    // Avoids paying the listInstalledApps() cost on the hot path and is
    // arguably more correct: if the user granted "Slack", the model asking
    // to open "Slack" should match THAT grant.
    const match = overrides.allowedApps.find(
      g => g.displayName.toLowerCase() === app.toLowerCase(),
    )
    targetBundleId = match?.bundleId
  }

  if (!targetBundleId || !allowed.has(targetBundleId)) {
    return errorResult(
      `"${app}" is not granted for this session. Call request_access first.`,
      'app_not_granted',
    )
  }

  // open_application works at any tier — bringing an app forward is exactly
  // what tier "read" enables (you need it on screen to screenshot it). The
  // tier gates on click/type catch any follow-up interaction.

  await adapter.executor.openApp(targetBundleId)

  // On multi-monitor setups, macOS may place the opened window on a monitor
  // the resolver won't pick (e.g. Claude + another allowed app are co-located
  // elsewhere). Nudge the model toward switch_display BEFORE it wastes steps
  // clicking on dock icons. Single-monitor → no hint. listDisplays failure is
  // non-fatal — the hint is advisory.
  if (overrides.onDisplayPinned !== undefined) {
    let displayCount = 1
    try {
      displayCount = (await adapter.executor.listDisplays()).length
    } catch {
      // hint skipped
    }
    if (displayCount >= 2) {
      return okText(
        `Opened "${app}". If it isn't visible in the next screenshot, it may ` +
          `have opened on a different monitor — use switch_display to check.`,
      )
    }
  }

  return okText(`Opened "${app}".`)
}

export type OpenTerminalOptions = Parameters<
  NonNullable<ComputerExecutor['openTerminal']>
>[0]

export function isTerminalAgent(
  value: string,
): value is OpenTerminalOptions['agent'] {
  return (
    value === 'self' ||
    value === 'codex' ||
    value === 'gemini' ||
    value === 'custom'
  )
}

export function isTerminalKind(
  value: unknown,
): value is NonNullable<OpenTerminalOptions['terminal']> {
  return value === 'wt' || value === 'powershell' || value === 'cmd'
}

export async function handleOpenTerminal(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
): Promise<CuCallToolResult> {
  if (!adapter.executor.openTerminal) {
    return errorResult(
      'open_terminal is only available on Windows.',
      'feature_unavailable',
    )
  }
  const agent = requireString(args, 'agent')
  if (agent instanceof Error) return errorResult(agent.message, 'bad_args')

  if (!isTerminalAgent(agent)) {
    return errorResult(
      `Invalid agent "${agent}". Valid: self, codex, gemini, custom.`,
      'bad_args',
    )
  }
  if (agent === 'custom' && typeof args.command !== 'string') {
    return errorResult(
      "agent='custom' requires 'command' parameter.",
      'bad_args',
    )
  }

  const result = await adapter.executor.openTerminal({
    agent,
    command: typeof args.command === 'string' ? args.command : undefined,
    terminal: isTerminalKind(args.terminal) ? args.terminal : undefined,
    workingDirectory:
      typeof args.working_directory === 'string'
        ? args.working_directory
        : undefined,
  })

  if (!result) {
    return errorResult(
      'Failed to open terminal. Windows Terminal (wt.exe) may not be installed.',
      'launch_failed',
    )
  }

  if (!result.launched) {
    return okText(
      `Terminal opened (hwnd=${result.hwnd}, "${result.title}") but no command was sent. Window is now bound.`,
    )
  }

  const agentNames: Record<string, string> = {
    self: 'the host CLI',
    codex: 'Codex',
    gemini: 'Gemini',
    custom: args.command as string,
  }

  return okText(
    `Terminal opened and ${agentNames[agent] ?? agent} launched.\n` +
      `Window: hwnd=${result.hwnd} "${result.title}"\n` +
      `Command: '${agent === 'custom' ? args.command : agent}' + Enter\n` +
      `Status: bound to this terminal. Take a screenshot to verify the agent started.`,
  )
}

export function handleListGrantedApplications(
  overrides: ComputerUseOverrides,
): CuCallToolResult {
  return okJson({
    allowedApps: overrides.allowedApps,
    grantFlags: overrides.grantFlags,
  })
}
