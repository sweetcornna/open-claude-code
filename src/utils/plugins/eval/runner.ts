/**
 * Suite orchestration: arms, runs, and the ceilings that stop them.
 *
 * THE ABLATION
 *
 * Every case runs twice per repetition. The two arms are assembled from the
 * same request object and differ in exactly one field — `pluginDirs` is the
 * plugin root in the `with` arm and empty in the `without` arm. Nothing else,
 * including the workspace seed, the prompt, the model and the environment,
 * is allowed to vary, because anything that does lands in the delta and gets
 * read as an effect of the plugin.
 *
 * CEILINGS ARE PART OF THE CONTRACT, NOT AN OPTION
 *
 * A suite is cases × runs × 2 arms agent sessions, so the arithmetic gets away
 * from people fast: five cases at three runs is thirty sessions. Cost and wall
 * clock are therefore always bounded, with conservative defaults, and both are
 * checked before each run rather than after — plus each run receives the
 * *remaining* budget as its own `--max-budget-usd`, so a single session cannot
 * overshoot the total it was granted.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentRunner } from './agentRunner.js'
import { evaluateAssertions } from './assertions.js'
import { buildCaseResult } from './aggregate.js'
import { runJudge } from './judge.js'
import { scoreGraders } from './types.js'
import type {
  AblationMode,
  Arm,
  CaseResult,
  EvalPlan,
  GraderResult,
  LoadedCase,
  PartialReason,
  RunResult,
  SuiteResult,
} from './types.js'

/**
 * Defaults chosen so that someone typing `occ plugin eval` for the first time,
 * on a suite they have not read, cannot lose more than pocket change or a
 * coffee break before they see output.
 */
export const DEFAULT_MAX_COST_USD = 5
export const DEFAULT_RUN_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_DURATION_MS = 1_800_000
export const DEFAULT_THRESHOLD = 1
export const DEFAULT_JUDGE_MODEL = 'haiku'

export type SuiteOptions = {
  root: string
  cases: LoadedCase[]
  loadErrors: Array<{ file: string; error: string }>
  ablation: AblationMode
  /** Plugin root handed to the `with` arm. */
  pluginRoot?: string
  pluginId?: string
  runner: AgentRunner
  model?: string
  judgeModel: string
  threshold: number
  maxCostUsd: number
  maxDurationMs: number
  runTimeoutMs: number
  allowCommands: boolean
  keepTemp: boolean
  /** Progress lines; the CLI sends these to stderr. */
  onLine: (line: string) => void
  signal?: AbortSignal
  /** Injectable for tests. */
  now?: () => number
  /** Suite workspace root. Defaults to a fresh OS temp directory. */
  workRoot?: string
}

/**
 * Create the directory that holds every run's sandbox.
 *
 * It must live in the OS temp tree, NOT under `occConfigPath()`. occ protects
 * its own config root from tool writes, so a workspace at
 * `~/.occ/plugin-eval/...` gets every `Write` denied — and the denial arrives
 * as a generic "don't ask mode" refusal, so it reads as a permission
 * misconfiguration rather than a bad sandbox location. Reports still go under
 * the config dir: the parent writes those with `fs`, not through a tool.
 */
export function createWorkRoot(): string {
  return mkdtempSync(join(tmpdir(), 'occ-plugin-eval-'))
}

/** What would run, without running it. Powers `--dry-run`. */
export function planSuite(
  cases: readonly LoadedCase[],
  ablation: AblationMode,
): EvalPlan {
  const arms: Arm[] =
    ablation === 'with-without' ? ['with', 'without'] : ['with']
  const planned = cases.map(c => {
    const runs = c.spec.runs
    const agentCalls = runs * arms.length
    // A judge call rides along with each agent run that has one declared —
    // and only then. A suite with no `judge:` block reports zero here, which
    // is the point of keeping the two counts separate.
    const judgeCalls = c.spec.judge === undefined ? 0 : agentCalls
    return {
      name: c.name,
      runs,
      agentCalls,
      judgeCalls,
      deniedTools: c.deniedTools,
    }
  })
  return {
    cases: planned,
    arms,
    totalAgentCalls: planned.reduce((s, c) => s + c.agentCalls, 0),
    totalJudgeCalls: planned.reduce((s, c) => s + c.judgeCalls, 0),
  }
}

/** Deterministic per-run sandbox path — same case, same arm, same layout. */
function runDir(
  workRoot: string,
  name: string,
  arm: Arm,
  index: number,
): string {
  return join(workRoot, name, arm, `run-${index + 1}`)
}

type Budget = {
  spent: number
  deadline: number
  reason?: PartialReason
}

/**
 * Decide whether the next run may start.
 *
 * Exported because these three conditions are the entire contract of
 * `--max-cost-usd`, `--max-duration` and Ctrl-C, and they deserve tests that
 * do not depend on a model.
 */
export function checkBudget(
  budget: Budget,
  options: { maxCostUsd: number; now: number; aborted: boolean },
): PartialReason | undefined {
  if (options.aborted) return 'interrupted'
  if (budget.spent >= options.maxCostUsd) return 'cost_ceiling'
  if (options.now >= budget.deadline) return 'time_ceiling'
  return undefined
}

async function executeRun(input: {
  loadedCase: LoadedCase
  arm: Arm
  index: number
  options: SuiteOptions
  budget: Budget
  workRoot: string
}): Promise<RunResult> {
  const { loadedCase, arm, index, options, budget } = input
  const dir = runDir(input.workRoot, loadedCase.name, arm, index)
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace, { recursive: true })

  // Seeded fresh every run, so two repetitions of the same case start from
  // byte-identical state and only model sampling varies.
  if (loadedCase.spec.files !== undefined) {
    const seed = join(loadedCase.dir, loadedCase.spec.files)
    try {
      cpSync(seed, workspace, { recursive: true })
    } catch (error) {
      return {
        arm,
        index,
        score: 0,
        graders: [],
        costUsd: 0,
        judgeCostUsd: 0,
        durationMs: 0,
        numTurns: 0,
        error: `could not seed workspace from "${loadedCase.spec.files}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
  }

  const now = options.now ?? Date.now
  const remainingBudget = Math.max(0, options.maxCostUsd - budget.spent)
  const remainingTime = Math.max(1000, budget.deadline - now())
  const timeoutMs = Math.min(
    loadedCase.spec.timeout_ms ?? options.runTimeoutMs,
    remainingTime,
  )

  const outcome = await options.runner.run({
    prompt: loadedCase.prompt,
    cwd: workspace,
    // The ablation, in one expression.
    pluginDirs:
      arm === 'with' && options.pluginRoot !== undefined
        ? [options.pluginRoot]
        : [],
    model: loadedCase.spec.model,
    allowedTools: loadedCase.allowedTools,
    maxTurns: loadedCase.spec.max_turns,
    timeoutMs,
    maxBudgetUsd: remainingBudget,
    traceDir: dir,
    signal: options.signal,
  })

  let graders: GraderResult[] = []
  let judgeCostUsd = 0

  if (outcome.ok) {
    graders = await evaluateAssertions(
      loadedCase.spec.assert,
      {
        workspace,
        outcome,
        allowCommands: options.allowCommands,
        signal: options.signal,
      },
      arm,
    )

    const judgeSpec = loadedCase.spec.judge
    const skipJudgeInThisArm =
      arm === 'without' && judgeSpec?.arm === 'with-only'
    if (judgeSpec !== undefined && !skipJudgeInThisArm) {
      const spentAfterAgent = budget.spent + outcome.costUsd
      if (spentAfterAgent >= options.maxCostUsd) {
        // Skipping the judge in one arm but not the other would grade the two
        // arms under different rules, so the delta is suppressed downstream by
        // marking this run failed rather than silently scoring it lower.
        graders.push({
          label: 'judge',
          kind: 'judge',
          passed: false,
          weight: judgeSpec.weight,
          withOnly: judgeSpec.arm === 'with-only',
          detail: 'skipped: cost ceiling reached before the judge could run',
        })
      } else {
        const judged = await runJudge({
          spec: judgeSpec,
          task: loadedCase.prompt,
          outcome,
          runner: options.runner,
          defaultModel: options.judgeModel,
          timeoutMs: Math.min(options.runTimeoutMs, remainingTime),
          maxBudgetUsd: Math.max(0, options.maxCostUsd - spentAfterAgent),
          signal: options.signal,
        })
        judgeCostUsd = judged.judgeCostUsd ?? 0
        graders.push(judged)
      }
    }
  }

  if (!options.keepTemp) {
    rmSync(dir, { recursive: true, force: true })
  }

  return {
    arm,
    index,
    score: outcome.ok ? scoreGraders(graders) : 0,
    graders,
    costUsd: outcome.costUsd,
    judgeCostUsd,
    durationMs: outcome.durationMs,
    numTurns: outcome.numTurns,
    error: outcome.error,
    workspacePath: options.keepTemp ? workspace : undefined,
  }
}

function formatCaseLine(result: CaseResult): string {
  const withScore = result.with.score.toFixed(2)
  if (result.without === undefined) {
    return `  ${result.name}  score ${withScore}  $${result.costUsd.toFixed(4)}`
  }
  const delta = result.delta ?? 0
  const sign = delta >= 0 ? '+' : ''
  return (
    `  ${result.name}  with ${withScore}  without ${result.without.score.toFixed(2)}` +
    `  Δ ${sign}${delta.toFixed(2)}  $${result.costUsd.toFixed(4)}`
  )
}

/** Run the whole suite. */
export async function runSuite(options: SuiteOptions): Promise<SuiteResult> {
  const now = options.now ?? Date.now
  const startedAtMs = now()
  const startedAt = new Date(startedAtMs).toISOString()
  const workRoot = options.workRoot ?? createWorkRoot()
  mkdirSync(workRoot, { recursive: true })
  if (options.keepTemp) options.onLine(`Sandboxes: ${workRoot}`)

  const arms: Arm[] =
    options.ablation === 'with-without' ? ['with', 'without'] : ['with']
  const budget: Budget = {
    spent: 0,
    deadline: startedAtMs + options.maxDurationMs,
  }

  const results: CaseResult[] = []

  outer: for (const loadedCase of options.cases) {
    const runsByArm = new Map<Arm, RunResult[]>()
    for (const arm of arms) {
      const runs: RunResult[] = []
      runsByArm.set(arm, runs)
      for (let index = 0; index < loadedCase.spec.runs; index++) {
        const stop = checkBudget(budget, {
          maxCostUsd: options.maxCostUsd,
          now: now(),
          aborted: options.signal?.aborted === true,
        })
        if (stop !== undefined) {
          budget.reason = stop
          options.onLine(stopMessage(stop, options))
          break outer
        }
        const run = await executeRun({
          loadedCase,
          arm,
          index,
          options,
          budget,
          workRoot,
        })
        budget.spent += run.costUsd + run.judgeCostUsd
        runs.push(run)
      }
    }
    // A case is only reported once both arms finished; a half-run case has no
    // meaningful delta and reporting one would be worse than reporting none.
    const withRuns = runsByArm.get('with') ?? []
    const withoutRuns = runsByArm.get('without')
    if (withRuns.length === loadedCase.spec.runs) {
      const result = buildCaseResult({
        name: loadedCase.name,
        dir: loadedCase.dir,
        withRuns,
        withoutRuns:
          arms.includes('without') &&
          withoutRuns?.length === loadedCase.spec.runs
            ? withoutRuns
            : undefined,
      })
      results.push(result)
      options.onLine(formatCaseLine(result))
    }
  }

  return {
    schemaVersion: 1,
    startedAt,
    durationMs: now() - startedAtMs,
    root: options.root,
    ablation: options.ablation,
    pluginId: options.pluginId,
    pluginRoot: options.pluginRoot,
    threshold: options.threshold,
    model: options.model,
    judgeModel: options.judgeModel,
    cases: results,
    loadErrors: options.loadErrors,
    costUsd: budget.spent,
    partial: budget.reason !== undefined,
    partialReason: budget.reason,
  }
}

function stopMessage(reason: PartialReason, options: SuiteOptions): string {
  switch (reason) {
    case 'cost_ceiling':
      return `stopped: cost ceiling $${options.maxCostUsd} reached`
    case 'time_ceiling':
      return `stopped: time ceiling ${Math.round(options.maxDurationMs / 1000)}s reached`
    case 'interrupted':
      return 'stopped: interrupted'
  }
}
