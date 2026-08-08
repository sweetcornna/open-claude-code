import { useInput } from '@anthropic/ink'

/**
 * The region that currently has focus. `detail` is the third level: the
 * selected agent's status view, opened from the agent list with Enter/→.
 */
export type FocusColumn = 'phases' | 'agents' | 'detail'

/** Keyboard mode: normal = regular navigation; confirm = a Dialog is open, waiting for the user's y/n confirmation. */
export type WorkflowKeyboardMode = 'normal' | 'confirm'

/** Subset of the useInput key object (only declares the fields we use, to avoid coupling to the ink Key type). */
type KeyEvent = {
  tab?: boolean
  shift?: boolean
  escape?: boolean
  return?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  upArrow?: boolean
  downArrow?: boolean
  pageUp?: boolean
  pageDown?: boolean
}

/** key -> action (pure function, easy to unit test; no rendering dependencies). */
export type WorkflowKeyAction =
  | 'nextTab'
  | 'prevTab'
  | 'focusLeft'
  | 'focusRight'
  | 'moveUp'
  | 'moveDown'
  | 'openDetail'
  | 'cancelTarget'
  | 'pageUp'
  | 'pageDown'
  | 'resume'
  | 'newRun'
  | 'cycleStatusFilter'
  | 'quit'
  | 'confirmYes'
  | 'confirmNo'

export function routeWorkflowKey(
  input: string,
  key: KeyEvent,
  mode: WorkflowKeyboardMode = 'normal',
): WorkflowKeyAction | null {
  // confirm mode: only y/Enter confirms, n/Esc/q cancels, all other keys are swallowed (prevent mis-touch)
  if (mode === 'confirm') {
    if (input === 'y' || input === 'Y' || key.return) return 'confirmYes'
    if (input === 'n' || input === 'N' || key.escape || input === 'q') {
      return 'confirmNo'
    }
    return null
  }
  // @anthropic/ink sets key.tab to true for the Tab key; some environments fall back to '\t'
  if (key.tab || input === '\t') return key.shift ? 'prevTab' : 'nextTab'
  if (key.escape || input === 'q') return 'quit'
  // Every task surface uses x for the target currently in focus. The panel
  // decides whether that target is the selected agent or the whole run.
  if (input === 'x') return 'cancelTarget'
  if (input === 'r') return 'resume'
  if (input === 'n') return 'newRun'
  if (input === 'f') return 'cycleStatusFilter'
  // Enter opens the selected agent's detail view. Right does the same from
  // the agent list (it is the next region rightward), so both the "drill in"
  // and the "move right" mental models land on the same place.
  if (key.return) return 'openDetail'
  // Left steps back out one level (detail -> agents -> phases) and stops
  // there: closing the panel is Esc's job, never an arrow's.
  if (key.leftArrow) return 'focusLeft'
  if (key.rightArrow) return 'focusRight'
  if (key.upArrow) return 'moveUp'
  if (key.downArrow) return 'moveDown'
  if (key.pageUp) return 'pageUp'
  if (key.pageDown) return 'pageDown'
  return null
}

/** Step one region left. Stops at 'phases' — arrows never close the panel. */
export function focusColumnLeftOf(current: FocusColumn): FocusColumn {
  if (current === 'detail') return 'agents'
  return 'phases'
}

/** Step one region right. 'agents' -> 'detail' is handled by the panel so it can refuse when no agent is selected. */
export function focusColumnRightOf(current: FocusColumn): FocusColumn {
  if (current === 'phases') return 'agents'
  return 'detail'
}

/** Focus model callbacks (injected by WorkflowsPanel). */
export type WorkflowKeyboardHandlers = {
  nextTab: () => void
  prevTab: () => void
  focusLeft: () => void
  focusRight: () => void
  moveUp: () => void
  moveDown: () => void
  /** Open the selected agent's detail view (no-op when nothing is selected). */
  openDetail: () => void
  /** Cycle the agent-list status filter (all → running → done → failed → all). */
  cycleStatusFilter: () => void
  /** Request cancellation of the target represented by the active pane. */
  cancelTarget: () => void
  /** Scroll the fixed detail viewport without changing agent selection. */
  pageUp: () => void
  pageDown: () => void
  resumeFocused: () => void
  newRun: () => void
  quit: () => void
  /** User confirms in confirm mode (y/Enter). */
  confirmYes: () => void
  /** User cancels in confirm mode (n/Esc/q). */
  confirmNo: () => void
}

/**
 * /workflows panel keybindings (focus rotation model):
 * - Tab / Shift+Tab: switch the top run tab
 * - Left / Right: step between phases → agents → agent detail
 * - Enter: open the selected agent's detail view
 * - Up / Down: always move the selected agent
 * - PageUp / PageDown: scroll the fixed detail viewport
 * - f cycle the agent status filter
 * - x cancel the active target (selected agent or whole workflow) · r resume · n new · q / Esc quit
 *
 * @param mode In confirm mode only y/n/Esc/q are accepted, all other keys are swallowed - avoid mis-navigation inside the confirmation dialog.
 */
export function useWorkflowKeyboard(
  h: WorkflowKeyboardHandlers,
  mode: WorkflowKeyboardMode = 'normal',
): void {
  useInput((input, key) => {
    const action = routeWorkflowKey(input, key as KeyEvent, mode)
    if (action === null) return
    switch (action) {
      case 'nextTab':
        h.nextTab()
        break
      case 'prevTab':
        h.prevTab()
        break
      case 'focusLeft':
        h.focusLeft()
        break
      case 'focusRight':
        h.focusRight()
        break
      case 'moveUp':
        h.moveUp()
        break
      case 'moveDown':
        h.moveDown()
        break
      case 'openDetail':
        h.openDetail()
        break
      case 'cycleStatusFilter':
        h.cycleStatusFilter()
        break
      case 'cancelTarget':
        h.cancelTarget()
        break
      case 'pageUp':
        h.pageUp()
        break
      case 'pageDown':
        h.pageDown()
        break
      case 'resume':
        h.resumeFocused()
        break
      case 'newRun':
        h.newRun()
        break
      case 'quit':
        h.quit()
        break
      case 'confirmYes':
        h.confirmYes()
        break
      case 'confirmNo':
        h.confirmNo()
        break
    }
  })
}
