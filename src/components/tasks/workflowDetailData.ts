// Legacy raw-key projection kept for keyboard compatibility tests.

type WorkflowDetailKeyAction =
  | 'moveUp'
  | 'moveDown'
  | 'openAgent'
  | 'back'
  | 'confirmYes'
  | 'confirmNo'

/**
 * Legacy raw-key projection kept for pure keyboard tests. WorkflowRunPanel owns
 * cancellation; k/K intentionally have no workflow-kill meaning.
 */
export function routeWorkflowDetailKey(
  key: string,
  mode: 'normal' | 'confirm',
): WorkflowDetailKeyAction | null {
  if (mode === 'confirm') {
    if (key === 'y' || key === 'Y' || key === 'return') return 'confirmYes'
    if (key === 'n' || key === 'N' || key === 'escape') return 'confirmNo'
    return null
  }
  if (key === 'up') return 'moveUp'
  if (key === 'down') return 'moveDown'
  if (key === 'return' || key === 'right') return 'openAgent'
  if (key === 'left') return 'back'
  return null
}
