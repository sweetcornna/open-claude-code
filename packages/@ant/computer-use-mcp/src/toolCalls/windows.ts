import type { ComputerUseHostAdapter, ComputerUseOverrides } from '../types.js'
import { errorResult, okText, requireString } from './core.js'
import type { CuCallToolResult } from './core.js'
import { uniqueDisplayLabels } from './screenshot.js'

export async function handleBindWindow(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
): Promise<CuCallToolResult> {
  const action = requireString(args, 'action')
  if (action instanceof Error) return errorResult(action.message, 'bad_args')

  switch (action) {
    case 'list': {
      if (!adapter.executor.listVisibleWindows) {
        return errorResult(
          'bind_window is only available on Windows.',
          'feature_unavailable',
        )
      }
      const windows = await adapter.executor.listVisibleWindows()
      if (windows.length === 0) return okText('No visible windows found.')
      const lines = windows.map(w => `hwnd=${w.hwnd} pid=${w.pid} "${w.title}"`)
      return okText(`Visible windows (${windows.length}):\n${lines.join('\n')}`)
    }
    case 'status': {
      if (!adapter.executor.getBindingStatus) {
        return errorResult(
          'bind_window is only available on Windows.',
          'feature_unavailable',
        )
      }
      const status = await adapter.executor.getBindingStatus()
      if (!status || !status.bound) {
        return okText(
          "No window is currently bound. Use bind_window(action='list') to see available windows, then bind_window(action='bind', title='...') to bind.",
        )
      }
      let text = `Bound to: hwnd=${status.hwnd}`
      if (status.title) text += ` "${status.title}"`
      if (status.pid) text += ` pid=${status.pid}`
      if (status.rect)
        text += ` rect=(${status.rect.x},${status.rect.y} ${status.rect.width}x${status.rect.height})`
      return okText(text)
    }
    case 'bind': {
      if (!adapter.executor.bindToWindow) {
        return errorResult(
          'bind_window is only available on Windows.',
          'feature_unavailable',
        )
      }
      const title = typeof args.title === 'string' ? args.title : undefined
      const hwnd = typeof args.hwnd === 'string' ? args.hwnd : undefined
      const pid = typeof args.pid === 'number' ? args.pid : undefined
      if (!title && !hwnd && !pid) {
        return errorResult(
          'Specify at least one of: title, hwnd, or pid.',
          'bad_args',
        )
      }
      const result = await adapter.executor.bindToWindow({ hwnd, title, pid })
      if (!result) {
        return errorResult(
          `No window found matching: ${[title && `title="${title}"`, hwnd && `hwnd=${hwnd}`, pid && `pid=${pid}`].filter(Boolean).join(', ')}. Use bind_window(action='list') to see available windows.`,
          'element_not_found',
        )
      }
      return okText(
        `Bound to window: hwnd=${result.hwnd} pid=${result.pid} "${result.title}". All subsequent screenshot/click/type operations target this window.`,
      )
    }
    case 'unbind': {
      if (!adapter.executor.unbindFromWindow) {
        return errorResult(
          'bind_window is only available on Windows.',
          'feature_unavailable',
        )
      }
      await adapter.executor.unbindFromWindow()
      return okText(
        'Window binding released. Operations now target the full screen.',
      )
    }
    default:
      return errorResult(
        `Unknown bind_window action "${action}". Valid: list, bind, unbind, status.`,
        'bad_args',
      )
  }
}

export async function handleClickElement(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
): Promise<CuCallToolResult> {
  if (!adapter.executor.clickElement) {
    return errorResult(
      'click_element is only available on Windows with a bound window.',
      'feature_unavailable',
    )
  }
  const name = typeof args.name === 'string' ? args.name : undefined
  const role = typeof args.role === 'string' ? args.role : undefined
  const automationId =
    typeof args.automationId === 'string' ? args.automationId : undefined
  if (!name && !role && !automationId) {
    return errorResult(
      'At least one of name, role, or automationId is required.',
      'bad_args',
    )
  }
  const ok = await adapter.executor.clickElement({ name, role, automationId })
  if (!ok) {
    return errorResult(
      `Element not found: ${[name && `name="${name}"`, role && `role=${role}`, automationId && `id=${automationId}`].filter(Boolean).join(', ')}. Take a screenshot to see current GUI elements.`,
      'element_not_found',
    )
  }
  return okText(
    `Clicked element: ${[name && `"${name}"`, role, automationId].filter(Boolean).join(' ')}`,
  )
}

export async function handleTypeIntoElement(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
): Promise<CuCallToolResult> {
  if (!adapter.executor.typeIntoElement) {
    return errorResult(
      'type_into_element is only available on Windows with a bound window.',
      'feature_unavailable',
    )
  }
  const text = requireString(args, 'text')
  if (text instanceof Error) return errorResult(text.message, 'bad_args')
  const name = typeof args.name === 'string' ? args.name : undefined
  const role = typeof args.role === 'string' ? args.role : undefined
  const automationId =
    typeof args.automationId === 'string' ? args.automationId : undefined
  const ok = await adapter.executor.typeIntoElement(
    { name, role, automationId },
    text,
  )
  if (!ok) {
    return errorResult(
      `Could not type into element: ${[name && `name="${name}"`, role && `role=${role}`, automationId && `id=${automationId}`].filter(Boolean).join(', ')}. The element was not found or doesn't support text input.`,
      'element_not_found',
    )
  }
  return okText(
    `Typed ${text.length} chars into: ${[name && `"${name}"`, role, automationId].filter(Boolean).join(' ')}`,
  )
}

export async function handleWindowManagement(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
): Promise<CuCallToolResult> {
  const action = requireString(args, 'action')
  if (action instanceof Error) return errorResult(action.message, 'bad_args')

  const VALID_ACTIONS = new Set([
    'minimize',
    'maximize',
    'restore',
    'close',
    'focus',
    'move_offscreen',
    'move_resize',
    'get_rect',
  ])
  if (!VALID_ACTIONS.has(action)) {
    return errorResult(
      `Unknown window_management action "${action}". Valid: ${[...VALID_ACTIONS].join(', ')}`,
      'bad_args',
    )
  }

  if (!adapter.executor.manageWindow) {
    return errorResult(
      'window_management is only available on Windows with a bound window.',
      'feature_unavailable',
    )
  }

  // get_rect: just return the current window position and size
  if (action === 'get_rect') {
    if (!adapter.executor.getWindowRect) {
      return errorResult('getWindowRect not available.', 'feature_unavailable')
    }
    const rect = await adapter.executor.getWindowRect()
    if (!rect) {
      return errorResult(
        'No window is currently bound. Call open_application first.',
        'bad_args',
      )
    }
    return okText(
      `Window rect: x=${rect.x}, y=${rect.y}, width=${rect.width}, height=${rect.height}`,
    )
  }

  // move_resize: requires x, y (width/height optional)
  if (action === 'move_resize') {
    const x = typeof args.x === 'number' ? args.x : undefined
    const y = typeof args.y === 'number' ? args.y : undefined
    if (x === undefined || y === undefined) {
      return errorResult('move_resize requires x and y parameters.', 'bad_args')
    }
    const width = typeof args.width === 'number' ? args.width : undefined
    const height = typeof args.height === 'number' ? args.height : undefined
    const ok = await adapter.executor.manageWindow(action, {
      x,
      y,
      width,
      height,
    })
    if (!ok) {
      return errorResult(
        'No window is currently bound. Call open_application first.',
        'bad_args',
      )
    }
    return okText(
      width && height
        ? `Moved window to (${x}, ${y}) and resized to ${width}×${height}.`
        : `Moved window to (${x}, ${y}).`,
    )
  }

  // All other actions: minimize, maximize, restore, close, focus, move_offscreen
  const ok = await adapter.executor.manageWindow(action)
  if (!ok) {
    return errorResult(
      'No window is currently bound. Call open_application first.',
      'bad_args',
    )
  }

  const descriptions: Record<string, string> = {
    minimize: 'Window minimized (ShowWindow SW_MINIMIZE).',
    maximize: 'Window maximized (ShowWindow SW_MAXIMIZE).',
    restore: 'Window restored (ShowWindow SW_RESTORE).',
    close:
      'Window closed (SendMessage WM_CLOSE). The window binding has been released.',
    focus: 'Window brought to front (SetForegroundWindow).',
    move_offscreen:
      'Window moved offscreen (-32000,-32000). Still usable via SendMessage/PrintWindow.',
  }

  return okText(descriptions[action] ?? `Action "${action}" completed.`)
}

export async function handleSwitchDisplay(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  const display = requireString(args, 'display')
  if (display instanceof Error) return errorResult(display.message, 'bad_args')

  if (!overrides.onDisplayPinned) {
    return errorResult(
      'Display switching is not available in this session.',
      'feature_unavailable',
    )
  }

  if (display.toLowerCase() === 'auto') {
    overrides.onDisplayPinned(undefined)
    return okText(
      'Returned to automatic monitor selection. Call screenshot to continue.',
    )
  }

  // Resolve label → displayId fresh. Same source buildMonitorNote reads,
  // so whatever name the model saw in a screenshot note resolves here.
  let displays
  try {
    displays = await adapter.executor.listDisplays()
  } catch (e) {
    return errorResult(
      `Failed to enumerate displays: ${String(e)}`,
      'display_error',
    )
  }

  if (displays.length < 2) {
    return errorResult(
      'Only one monitor is connected. There is nothing to switch to.',
      'bad_args',
    )
  }

  const labels = uniqueDisplayLabels(displays)
  const wanted = display.toLowerCase()
  const target = displays.find(
    d => labels.get(d.displayId)?.toLowerCase() === wanted,
  )
  if (!target) {
    const available = displays
      .map(d => `"${labels.get(d.displayId)}"`)
      .join(', ')
    return errorResult(
      `No monitor named "${display}" is connected. Available monitors: ${available}.`,
      'bad_args',
    )
  }

  overrides.onDisplayPinned(target.displayId)
  return okText(
    `Switched to monitor "${labels.get(target.displayId)}". Call screenshot to see it.`,
  )
}
