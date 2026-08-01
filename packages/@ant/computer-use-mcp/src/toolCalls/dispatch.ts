import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  CuSubGates,
} from '../types.js'
import {
  handleListGrantedApplications,
  handleOpenApplication,
  handleOpenTerminal,
} from './apps.js'
import { handleComputerBatch } from './batch.js'
import { handleClickVariant } from './click.js'
import { handleReadClipboard, handleWriteClipboard } from './clipboard.js'
import { errorResult } from './core.js'
import type { CuCallToolResult } from './core.js'
import {
  handleHoldKey,
  handleKey,
  handleType,
  handleVirtualKeyboard,
} from './keyboard.js'
import { handleCursorPosition, handleWait, handleZoom } from './misc.js'
import {
  handleDrag,
  handleLeftMouseDown,
  handleLeftMouseUp,
  handleMoveMouse,
  handleScroll,
} from './mouse.js'
import { handleScreenshot } from './screenshot.js'
import {
  handleBindWindow,
  handleClickElement,
  handleSwitchDisplay,
  handleTypeIntoElement,
  handleWindowManagement,
} from './windows.js'
import {
  handleActivateWindow,
  handleMouseWheel,
  handlePromptRespond,
  handleStatusIndicator,
  handleVirtualMouse,
} from './windowsInput.js'

/**
 * Action dispatch shared by handleToolCall and handleComputerBatch. Called
 * AFTER kill-switch + TCC gates have passed. Never sees request_access — it's
 * special-cased in handleToolCall for the tccState thread-through.
 */
export async function dispatchAction(
  name: string,
  a: Record<string, unknown>,
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  // ── Bound-window auto-routing ──────────────────────────────────────
  // When a window is bound (Win32), route generic input tools to
  // virtual_mouse / virtual_keyboard automatically. The model doesn't
  // need to know which tools to use — binding handles it.
  const hasBoundWindow =
    (await adapter.executor.hasBoundWindow?.()) === true &&
    adapter.executor.virtualMouse &&
    adapter.executor.virtualKeyboard
  if (hasBoundWindow) {
    const coord = Array.isArray(a.coordinate)
      ? (a.coordinate as number[])
      : undefined
    switch (name) {
      case 'left_click':
        if (coord)
          return handleVirtualMouse(adapter, {
            action: 'click',
            coordinate: coord,
          })
        break
      case 'double_click':
        if (coord)
          return handleVirtualMouse(adapter, {
            action: 'double_click',
            coordinate: coord,
          })
        break
      case 'right_click':
        if (coord)
          return handleVirtualMouse(adapter, {
            action: 'right_click',
            coordinate: coord,
          })
        break
      case 'mouse_move':
        if (coord)
          return handleVirtualMouse(adapter, {
            action: 'move',
            coordinate: coord,
          })
        break
      case 'left_click_drag':
        if (coord)
          return handleVirtualMouse(adapter, {
            action: 'drag',
            coordinate: coord,
            start_coordinate: Array.isArray(a.start_coordinate)
              ? a.start_coordinate
              : undefined,
          })
        break
      case 'left_mouse_down':
        if (coord)
          return handleVirtualMouse(adapter, {
            action: 'down',
            coordinate: coord,
          })
        break
      case 'left_mouse_up':
        if (coord)
          return handleVirtualMouse(adapter, {
            action: 'up',
            coordinate: coord,
          })
        break
      case 'type':
        if (typeof a.text === 'string')
          return handleVirtualKeyboard(adapter, {
            action: 'type',
            text: a.text,
          })
        break
      case 'key':
        if (typeof a.text === 'string')
          return handleVirtualKeyboard(adapter, {
            action: 'combo',
            text: a.text,
            repeat: a.repeat,
          })
        break
      case 'hold_key':
        if (typeof a.text === 'string')
          return handleVirtualKeyboard(adapter, {
            action: 'hold',
            text: a.text,
            duration: typeof a.duration === 'number' ? a.duration : 1,
          })
        break
      case 'scroll':
        if (coord)
          return handleMouseWheel(adapter, {
            coordinate: coord,
            delta:
              a.scroll_direction === 'up'
                ? (a.scroll_amount ?? 3)
                : -(a.scroll_amount ?? 3),
            direction:
              a.scroll_direction === 'left' || a.scroll_direction === 'right'
                ? 'horizontal'
                : 'vertical',
          })
        break
      // screenshot, zoom, wait, cursor_position — not rerouted, pass through
    }
  }
  // ── Standard dispatch (unbound or tools not rerouted above) ────────
  switch (name) {
    case 'screenshot':
      return handleScreenshot(adapter, overrides, subGates)

    case 'zoom':
      return handleZoom(adapter, a, overrides)

    case 'left_click':
      return handleClickVariant(adapter, a, overrides, subGates, 'left', 1)
    case 'double_click':
      return handleClickVariant(adapter, a, overrides, subGates, 'left', 2)
    case 'triple_click':
      return handleClickVariant(adapter, a, overrides, subGates, 'left', 3)
    case 'right_click':
      return handleClickVariant(adapter, a, overrides, subGates, 'right', 1)
    case 'middle_click':
      return handleClickVariant(adapter, a, overrides, subGates, 'middle', 1)

    case 'type':
      return handleType(adapter, a, overrides, subGates)

    case 'key':
      return handleKey(adapter, a, overrides, subGates)

    case 'scroll':
      return handleScroll(adapter, a, overrides, subGates)

    case 'left_click_drag':
      return handleDrag(adapter, a, overrides, subGates)

    case 'mouse_move':
      return handleMoveMouse(adapter, a, overrides, subGates)

    case 'wait':
      return handleWait(a)

    case 'cursor_position':
      return handleCursorPosition(adapter, overrides)

    case 'hold_key':
      return handleHoldKey(adapter, a, overrides, subGates)

    case 'left_mouse_down':
      return handleLeftMouseDown(adapter, overrides, subGates)

    case 'left_mouse_up':
      return handleLeftMouseUp(adapter, overrides, subGates)

    case 'open_application':
      return handleOpenApplication(adapter, a, overrides)

    case 'window_management':
      return handleWindowManagement(adapter, a)

    case 'click_element':
      return handleClickElement(adapter, a)

    case 'type_into_element':
      return handleTypeIntoElement(adapter, a)

    case 'open_terminal':
      return handleOpenTerminal(adapter, a)

    case 'bind_window':
      return handleBindWindow(adapter, a)

    case 'virtual_mouse':
      return handleVirtualMouse(adapter, a)

    case 'virtual_keyboard':
      return handleVirtualKeyboard(adapter, a)

    case 'status_indicator':
      return handleStatusIndicator(adapter, a)

    case 'mouse_wheel':
      return handleMouseWheel(adapter, a)

    case 'activate_window':
      return handleActivateWindow(adapter, a)

    case 'prompt_respond':
      return handlePromptRespond(adapter, a)

    case 'switch_display':
      return handleSwitchDisplay(adapter, a, overrides)

    case 'list_granted_applications':
      return handleListGrantedApplications(overrides)

    case 'read_clipboard':
      return handleReadClipboard(adapter, overrides, subGates)

    case 'write_clipboard':
      return handleWriteClipboard(adapter, a, overrides, subGates)

    case 'computer_batch':
      return handleComputerBatch(adapter, a, overrides, subGates)

    default:
      return errorResult(`Unknown tool "${name}".`, 'bad_args')
  }
}
