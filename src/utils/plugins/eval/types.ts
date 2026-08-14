/**
 * Shared value types for `occ plugin eval`.
 *
 * Kept dependency-free (types plus two tiny helpers) so the pure scoring,
 * assertion and rendering modules never pull in `child_process` transitively.
 */

import type { Assertion, EvalCaseFile } from './caseSchema.js'

/** The two ablation arms. `with` has the plugin loaded, `without` does not. */
export type Arm = 'with' | 'without'

export type AblationMode = 'with-without' | 'none'

/** A case after loading: the declaration plus where it came from. */
export type LoadedCase = {
  /** Resolved case name (declaration wins, else directory basename). */
  name: string
  /** Absolute path of the case directory. */
  dir: string
  /** Absolute path of the `case.yaml` that produced it. */
  file: string
  spec: EvalCaseFile
  /** Prompt text, already resolved from `prompt` or `prompt_file`. */
  prompt: string
  /** Tools the case asked for that the operator has not granted. */
  deniedTools: string[]
  /** Tools actually passed to the agent. */
  allowedTools: string[]
}

/** A single tool invocation observed in the run transcript. */
export type ToolCall = {
  name: string
  /** Raw input object, serialised for `input_matches`. */
  inputJson: string
}

/** What one agent run produced. Everything graders need, and nothing else. */
export type AgentRunOutcome = {
  /** False when the agent errored, timed out, or was killed. */
  ok: boolean
  /** Final assistant text. Empty when the run failed. */
  output: string
  toolCalls: ToolCall[]
  costUsd: number
  numTurns: number
  durationMs: number
  sessionId?: string
  /** Populated when `ok` is false. */
  error?: string
}

/** One grader's verdict within a run. */
export type GraderResult = {
  label: string
  /** `assert` for deterministic graders, `judge` for the LLM one. */
  kind: 'assert' | 'judge'
  passed: boolean
  weight: number
  /** True when excluded from scoring (with-only assertions). */
  withOnly: boolean
  /** Why it passed or failed. Shown verbatim in reports. */
  detail: string
  /** Judge-only: what the judge call cost. */
  judgeCostUsd?: number
}

/** One (case, arm, run-index) triple. */
export type RunResult = {
  arm: Arm
  index: number
  /** 0 when the agent run failed — graders do not run in that case. */
  score: number
  graders: GraderResult[]
  costUsd: number
  judgeCostUsd: number
  durationMs: number
  numTurns: number
  error?: string
  /** Kept sandbox path, when `--keep-temp` was passed. */
  workspacePath?: string
}

/** Per-arm rollup for one case. */
export type ArmAggregate = {
  /** Mean of run scores. */
  score: number
  /** Fraction of runs that scored a perfect 1. */
  passRate: number
  runs: RunResult[]
}

export type CaseResult = {
  name: string
  dir: string
  /** Absent when `--ablation none`. */
  with: ArmAggregate
  without?: ArmAggregate
  /** `with.score - without.score`. Undefined when there is no control arm. */
  delta?: number
  costUsd: number
}

/** Why a suite stopped before running everything it planned. */
export type PartialReason = 'cost_ceiling' | 'time_ceiling' | 'interrupted'

export type SuiteResult = {
  schemaVersion: 1
  startedAt: string
  durationMs: number
  root: string
  ablation: AblationMode
  /** Plugin under test, when the target resolved to one. */
  pluginId?: string
  pluginRoot?: string
  threshold: number
  model?: string
  judgeModel?: string
  cases: CaseResult[]
  /** Case files that failed to load. */
  loadErrors: Array<{ file: string; error: string }>
  costUsd: number
  partial: boolean
  partialReason?: PartialReason
}

/** What `--dry-run` prints instead of spending anything. */
export type EvalPlan = {
  cases: Array<{
    name: string
    runs: number
    /** Agent invocations = runs × arms. */
    agentCalls: number
    /** Judge invocations, 0 when the case declares no `judge` block. */
    judgeCalls: number
    deniedTools: string[]
  }>
  arms: Arm[]
  totalAgentCalls: number
  totalJudgeCalls: number
}

/** Assertions that never participate in scoring, in either arm. */
export function isWithOnly(assertion: Assertion): boolean {
  return assertion.arm === 'with-only'
}

/**
 * Weighted pass fraction over the graders that count.
 *
 * With-only graders are skipped: they can only pass in one arm, so scoring
 * them would bake a guaranteed delta into every case that has one.
 */
export function scoreGraders(graders: readonly GraderResult[]): number {
  let earned = 0
  let total = 0
  for (const g of graders) {
    if (g.withOnly) continue
    total += g.weight
    if (g.passed) earned += g.weight
  }
  return total > 0 ? earned / total : 0
}
