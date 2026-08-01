export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Tools that check the lock but don't acquire it. `request_access` and
 * `list_granted_applications` hit the CHECK (so a blocked session doesn't
 * show an approval dialog for access it can't use) but defer ACQUIRE — the
 * enter-CU notification/overlay only fires on the first action tool.
 *
 * `request_teach_access` is NOT here: approving teach mode hides the main
 * window, and the lock must be held before that. See Gate-3 block in
 * `handleToolCall` for the full explanation.
 *
 * Exported for `bindSessionContext` in mcpServer.ts so the async lock gate
 * uses the same set as the sync one.
 */
export function defersLockAcquire(toolName: string): boolean {
  return (
    toolName === 'request_access' || toolName === 'list_granted_applications'
  )
}
