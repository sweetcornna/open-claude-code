import type { ComputerUseHostAdapter } from '../types.js'
import { errorResult, okText, requireString } from './core.js'
import type { CuCallToolResult } from './core.js'

export async function handleVirtualMouse(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
): Promise<CuCallToolResult> {
  if (!adapter.executor.virtualMouse) {
    return errorResult(
      'virtual_mouse is only available on Windows with a bound window.',
      'feature_unavailable',
    )
  }
  const action = requireString(args, 'action')
  if (action instanceof Error) return errorResult(action.message, 'bad_args')
  const coord = args.coordinate
  if (!Array.isArray(coord) || coord.length < 2) {
    return errorResult('coordinate [x, y] is required.', 'bad_args')
  }
  const validActions = new Set([
    'click',
    'double_click',
    'right_click',
    'move',
    'drag',
    'down',
    'up',
  ])
  if (!validActions.has(action)) {
    return errorResult(
      `Invalid action "${action}". Valid: ${[...validActions].join(', ')}`,
      'bad_args',
    )
  }
  const startCoord = Array.isArray(args.start_coordinate)
    ? args.start_coordinate
    : undefined
  const ok = await adapter.executor.virtualMouse({
    action: action as any,
    x: coord[0],
    y: coord[1],
    startX: startCoord?.[0],
    startY: startCoord?.[1],
  })
  if (!ok) {
    return errorResult('No window is currently bound.', 'bad_args')
  }
  const desc: Record<string, string> = {
    click: `Click at (${coord[0]},${coord[1]})`,
    double_click: `Double-click at (${coord[0]},${coord[1]})`,
    right_click: `Right-click at (${coord[0]},${coord[1]})`,
    move: `Moved to (${coord[0]},${coord[1]})`,
    drag: `Dragged ${startCoord ? `(${startCoord[0]},${startCoord[1]})` : 'current'} → (${coord[0]},${coord[1]})`,
    down: `Button down at (${coord[0]},${coord[1]})`,
    up: `Button up at (${coord[0]},${coord[1]})`,
  }
  return okText(desc[action] ?? action)
}

export async function handleStatusIndicator(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
): Promise<CuCallToolResult> {
  if (!adapter.executor.statusIndicator) {
    return errorResult(
      'status_indicator is only available on Windows.',
      'feature_unavailable',
    )
  }
  const action = requireString(args, 'action')
  if (action instanceof Error) return errorResult(action.message, 'bad_args')
  if (!['show', 'hide', 'status'].includes(action)) {
    return errorResult(
      `Invalid action "${action}". Valid: show, hide, status.`,
      'bad_args',
    )
  }
  const message = typeof args.message === 'string' ? args.message : undefined
  if (action === 'show' && !message) {
    return errorResult("'show' requires a message parameter.", 'bad_args')
  }
  const result = await adapter.executor.statusIndicator(action as any, message)
  if (action === 'status') {
    return okText(
      result.active
        ? 'Indicator is active on the bound window.'
        : 'Indicator is not active (no window bound).',
    )
  }
  if (action === 'show') {
    return okText(`Indicator showing: "${message}"`)
  }
  return okText('Indicator hidden.')
}

export async function handleMouseWheel(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
): Promise<CuCallToolResult> {
  if (!adapter.executor.mouseWheel) {
    return errorResult(
      'mouse_wheel is only available on Windows with a bound window.',
      'feature_unavailable',
    )
  }
  const coord = args.coordinate
  if (!Array.isArray(coord) || coord.length < 2) {
    return errorResult('coordinate must be [x, y] array.', 'bad_args')
  }
  const delta = typeof args.delta === 'number' ? args.delta : undefined
  if (delta === undefined) {
    return errorResult(
      'delta is required (positive=up, negative=down).',
      'bad_args',
    )
  }
  const horizontal = args.direction === 'horizontal'
  const ok = await adapter.executor.mouseWheel(
    coord[0],
    coord[1],
    delta,
    horizontal,
  )
  if (!ok) {
    return errorResult(
      'No window is currently bound. Use open_application or bind_window first.',
      'bad_args',
    )
  }
  return okText(
    `Mouse wheel: ${horizontal ? 'horizontal' : 'vertical'} scroll ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} click(s) at (${coord[0]},${coord[1]}).`,
  )
}

export async function handleActivateWindow(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
): Promise<CuCallToolResult> {
  if (!adapter.executor.activateWindow) {
    return errorResult(
      'activate_window is only available on Windows with a bound window.',
      'feature_unavailable',
    )
  }
  const clickX = typeof args.click_x === 'number' ? args.click_x : undefined
  const clickY = typeof args.click_y === 'number' ? args.click_y : undefined
  const ok = await adapter.executor.activateWindow(clickX, clickY)
  if (!ok) {
    return errorResult(
      'No window is currently bound. Use open_application or bind_window first.',
      'bad_args',
    )
  }
  return okText('Window activated and focused. Ready for input.')
}

export async function handlePromptRespond(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
): Promise<CuCallToolResult> {
  if (!adapter.executor.respondToPrompt) {
    return errorResult(
      'prompt_respond is only available on Windows with a bound window.',
      'feature_unavailable',
    )
  }
  const responseType = requireString(args, 'response_type')
  if (responseType instanceof Error)
    return errorResult(responseType.message, 'bad_args')

  const validTypes = new Set(['yes', 'no', 'enter', 'escape', 'select', 'type'])
  if (!validTypes.has(responseType)) {
    return errorResult(
      `Invalid response_type "${responseType}". Valid: ${[...validTypes].join(', ')}`,
      'bad_args',
    )
  }

  if (responseType === 'select' && typeof args.arrow_count !== 'number') {
    return errorResult("'select' requires arrow_count parameter.", 'bad_args')
  }
  if (responseType === 'type' && typeof args.text !== 'string') {
    return errorResult("'type' requires text parameter.", 'bad_args')
  }

  const ok = await adapter.executor.respondToPrompt({
    responseType: responseType as any,
    arrowDirection:
      typeof args.arrow_direction === 'string'
        ? (args.arrow_direction as any)
        : undefined,
    arrowCount:
      typeof args.arrow_count === 'number' ? args.arrow_count : undefined,
    text: typeof args.text === 'string' ? args.text : undefined,
  })

  if (!ok) {
    return errorResult(
      'No window is currently bound. Use open_application or bind_window first.',
      'bad_args',
    )
  }

  const descriptions: Record<string, string> = {
    yes: "Sent 'y' + Enter.",
    no: "Sent 'n' + Enter.",
    enter: 'Sent Enter.',
    escape: 'Sent Escape.',
    select: `Navigated ${args.arrow_direction ?? 'down'} ${args.arrow_count ?? 1} time(s) + Enter.`,
    type: `Typed "${args.text}" + Enter.`,
  }

  return okText(
    `Prompt responded: ${descriptions[responseType] ?? responseType}. Take a screenshot to verify.`,
  )
}
