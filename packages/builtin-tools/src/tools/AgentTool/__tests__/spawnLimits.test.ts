import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  checkSpawnBudgets,
  maxConcurrentSubagents,
  maxSubagentSpawnDepth,
  maxSubagentsPerSession,
  registerSpawn,
  resetSpawnBudgetsForTests,
  runningAgentCount,
  unregisterSpawn,
} from '../spawnLimits.js'

const ENV_KEYS = [
  'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION',
  'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
  'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
] as const

describe('subagent spawn budgets', () => {
  const savedEnv = Object.fromEntries(
    ENV_KEYS.map(key => [key, process.env[key]]),
  )

  beforeEach(() => {
    resetSpawnBudgetsForTests()
    for (const key of ENV_KEYS) delete process.env[key]
  })

  afterEach(() => {
    resetSpawnBudgetsForTests()
    for (const key of ENV_KEYS) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('defaults: unlimited per session, 20 concurrent, depth 3; env overrides win', () => {
    // The cumulative cap is opt-in: it only resets on /clear, so a default
    // ceiling stops long orchestration sessions partway through legitimate
    // work. Concurrency and depth keep their defaults — they bound live
    // resource use, not total work done.
    expect(maxSubagentsPerSession()).toBe(Number.POSITIVE_INFINITY)
    expect(maxConcurrentSubagents()).toBe(20)
    expect(maxSubagentSpawnDepth()).toBe(3)
    process.env.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION = '5'
    process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '2'
    process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '1'
    expect(maxSubagentsPerSession()).toBe(5)
    expect(maxConcurrentSubagents()).toBe(2)
    expect(maxSubagentSpawnDepth()).toBe(1)
    process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = 'deep'
    expect(maxSubagentSpawnDepth()).toBe(3)
  })

  test('session budget: spawns accumulate and are not released by completion', () => {
    process.env.CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION = '3'
    for (let i = 0; i < 3; i++) {
      checkSpawnBudgets(0)
      registerSpawn(`agent-${i}`)
      unregisterSpawn(`agent-${i}`)
    }
    expect(() => checkSpawnBudgets(0)).toThrow('session budget exhausted')
  })

  test('concurrency: released slots free up capacity', () => {
    process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '2'
    registerSpawn('a')
    registerSpawn('b')
    expect(() => checkSpawnBudgets(0)).toThrow('Too many concurrent')
    unregisterSpawn('a')
    expect(runningAgentCount()).toBe(1)
    checkSpawnBudgets(0) // no throw
  })

  test('depth: parent at limit cannot spawn; shallower parents can', () => {
    expect(() => checkSpawnBudgets(3)).toThrow('nesting depth limit')
    checkSpawnBudgets(2) // no throw
    checkSpawnBudgets(undefined) // main thread — no throw
  })

  test('unregister is idempotent', () => {
    registerSpawn('x')
    unregisterSpawn('x')
    unregisterSpawn('x')
    expect(runningAgentCount()).toBe(0)
  })

  test('an unset session budget never exhausts', () => {
    // A real session spawned 216 subagents across six stages; the old default
    // of 200 would have failed the last one.
    for (let i = 0; i < 250; i++) {
      checkSpawnBudgets(0)
      registerSpawn(`agent-${i}`)
      unregisterSpawn(`agent-${i}`)
    }
    expect(() => checkSpawnBudgets(0)).not.toThrow()
  })
})
