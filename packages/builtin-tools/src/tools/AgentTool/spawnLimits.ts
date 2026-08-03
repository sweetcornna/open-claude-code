/**
 * Subagent spawn budgets (official 2.1.212/2.1.217/2.1.172 parity):
 *
 * - CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION (default 200) — cumulative spawns
 *   per process lifetime; a runaway spawn loop burns real money.
 * - CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS (default 20) — simultaneously
 *   running subagents. Tracked here in a module-level Set keyed by agentId;
 *   deliberately NOT derived from appState.tasks — foreground agents skip
 *   task registration under CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, and
 *   `agentDefinitions.activeAgents` is a same-name trap (that's the agent
 *   DEFINITION list, not running instances).
 * - CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH (default 3) — nesting depth,
 *   carried on ToolUseContext.agentDepth (an env var cannot carry it:
 *   subagents run in-process and share process.env with siblings).
 *
 * Same env parsing posture as WebSearchTool/sessionLimit.ts:
 * Number.parseInt + isFinite + > 0, garbage falls back to the default.
 */

const DEFAULT_MAX_SUBAGENTS_PER_SESSION = 200
const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 20
const DEFAULT_MAX_SPAWN_DEPTH = 3

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return fallback
}

export function maxSubagentsPerSession(): number {
  return positiveIntEnv(
    'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION',
    DEFAULT_MAX_SUBAGENTS_PER_SESSION,
  )
}

export function maxConcurrentSubagents(): number {
  return positiveIntEnv(
    'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
    DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  )
}

export function maxSubagentSpawnDepth(): number {
  return positiveIntEnv(
    'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
    DEFAULT_MAX_SPAWN_DEPTH,
  )
}

let spawnedThisSession = 0
const runningAgents = new Set<string>()

/**
 * Guard called at the top of AgentTool.call before any spawn path. Throws a
 * descriptive error the model can relay when a budget is exhausted.
 */
export function checkSpawnBudgets(agentDepth: number | undefined): void {
  if (spawnedThisSession >= maxSubagentsPerSession()) {
    throw new Error(
      `Subagent session budget exhausted (${maxSubagentsPerSession()} spawns). ` +
        `Raise with CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION.`,
    )
  }
  if (runningAgents.size >= maxConcurrentSubagents()) {
    throw new Error(
      `Too many concurrent subagents (${runningAgents.size} running, limit ` +
        `${maxConcurrentSubagents()}). Wait for running agents to finish or raise ` +
        `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS.`,
    )
  }
  if ((agentDepth ?? 0) >= maxSubagentSpawnDepth()) {
    throw new Error(
      `Subagent nesting depth limit reached (${maxSubagentSpawnDepth()}). ` +
        `This agent is already ${agentDepth} level(s) deep — complete the task ` +
        `directly instead of delegating further, or raise ` +
        `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH.`,
    )
  }
}

/** Register a spawn. Call ONLY after checkSpawnBudgets passed. */
export function registerSpawn(agentId: string): void {
  spawnedThisSession++
  runningAgents.add(agentId)
}

/** Idempotent — safe to call from finally blocks on every exit path. */
export function unregisterSpawn(agentId: string): void {
  runningAgents.delete(agentId)
}

/** Test hooks. */
export function resetSpawnBudgetsForTests(): void {
  spawnedThisSession = 0
  runningAgents.clear()
}
export function runningAgentCount(): number {
  return runningAgents.size
}
