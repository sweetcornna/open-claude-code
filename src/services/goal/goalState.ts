/**
 * Stub for the goal feature module.
 *
 * The goal feature is not yet implemented. This stub exists so that
 * PromptInputFooterLeftSide.tsx's require() can be resolved by Bun's
 * bundler (build.ts). At runtime, getGoal() returns null, so the
 * GoalElapsedIndicator component renders nothing.
 *
 * When the goal feature is implemented, replace this stub with the
 * real implementation.
 */

export type GoalState = {
  status:
    | 'active'
    | 'paused'
    | 'budget_limited'
    | 'usage_limited'
    | 'blocked'
    | 'complete'
  [key: string]: unknown
}

export function getGoal(): GoalState | null {
  return null
}

export function getActiveElapsedMs(_goal: GoalState): number {
  return 0
}
