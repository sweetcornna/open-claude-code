/**
 * "Is any goal live in this process?" — a single boolean, deliberately kept
 * in a module with **zero imports**.
 *
 * `isDeferredTool()` (packages/builtin-tools) has to answer this question to
 * decide whether GoalTool is visible, but it must not pull in `goalState.ts`
 * and its `bootstrap/state` / telemetry dependencies: builtin-tools is a leaf
 * package, and the cycle ratchet (`bun run check:cycles`) is strict in both
 * directions. A leaf flag that imports nothing can be read from either side
 * without adding an edge to the graph.
 *
 * `goalState.ts` owns the write side and refreshes this on every mutation.
 */

let goalPresent = false

/** Called by goalState on every set/clear so readers never see stale state. */
export function setGoalPresent(present: boolean): void {
  goalPresent = present
}

/**
 * True when at least one session in this process has a goal record.
 * Intentionally coarse: sub-sessions share the flag, which only ever makes
 * GoalTool *more* visible — never less — so a worktree agent cannot lose the
 * tool the steering prompt tells it to call.
 */
export function isGoalPresent(): boolean {
  return goalPresent
}
