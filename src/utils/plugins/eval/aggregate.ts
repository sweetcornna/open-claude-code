/**
 * Turning runs into numbers. Pure — no fs, no processes, no clock.
 *
 * The headline number is the delta, not the score. "This plugin's suite scores
 * 0.8" says nothing on its own: the cases might be easy, or the base model
 * might already handle them. `with − without` is the only figure that answers
 * the question someone runs this command to ask.
 */

import type {
  ArmAggregate,
  CaseResult,
  RunResult,
  SuiteResult,
} from './types.js'

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

/**
 * Roll up one arm's runs.
 *
 * `score` is the mean so a partial success shows as partial. `passRate` counts
 * only perfect runs, which is the number that matters when a case's assertions
 * are all-or-nothing.
 */
export function aggregateArm(runs: readonly RunResult[]): ArmAggregate {
  return {
    score: mean(runs.map(r => r.score)),
    passRate:
      runs.length === 0
        ? 0
        : runs.filter(r => r.score >= 1).length / runs.length,
    runs: [...runs],
  }
}

export function buildCaseResult(input: {
  name: string
  dir: string
  withRuns: readonly RunResult[]
  withoutRuns?: readonly RunResult[]
}): CaseResult {
  const withArm = aggregateArm(input.withRuns)
  const withoutArm =
    input.withoutRuns === undefined
      ? undefined
      : aggregateArm(input.withoutRuns)
  const allRuns = [...input.withRuns, ...(input.withoutRuns ?? [])]
  return {
    name: input.name,
    dir: input.dir,
    with: withArm,
    without: withoutArm,
    delta:
      withoutArm === undefined ? undefined : withArm.score - withoutArm.score,
    costUsd: allRuns.reduce((sum, r) => sum + r.costUsd + r.judgeCostUsd, 0),
  }
}

/** How a case's delta reads in a report. */
export type CaseVerdict = 'improved' | 'flat' | 'regressed' | 'no-baseline'

/**
 * Deltas are means of noisy samples, so an exact-zero test would classify
 * floating-point dust as a real effect. One hundredth of a point is well below
 * anything a reasonable case can resolve.
 */
export const DELTA_EPSILON = 0.005

export function caseVerdict(result: CaseResult): CaseVerdict {
  if (result.delta === undefined) return 'no-baseline'
  if (result.delta > DELTA_EPSILON) return 'improved'
  if (result.delta < -DELTA_EPSILON) return 'regressed'
  return 'flat'
}

export type SuiteTotals = {
  overallScore: number
  meanDelta?: number
  improved: number
  flat: number
  regressed: number
  casesPassed: number
  casesBelowThreshold: string[]
  regressedCases: string[]
}

export function summarize(
  cases: readonly CaseResult[],
  threshold: number,
): SuiteTotals {
  const deltas = cases
    .map(c => c.delta)
    .filter((d): d is number => d !== undefined)
  const verdicts = cases.map(caseVerdict)
  return {
    overallScore: mean(cases.map(c => c.with.score)),
    meanDelta: deltas.length > 0 ? mean(deltas) : undefined,
    improved: verdicts.filter(v => v === 'improved').length,
    flat: verdicts.filter(v => v === 'flat').length,
    regressed: verdicts.filter(v => v === 'regressed').length,
    casesPassed: cases.filter(c => c.with.score >= threshold).length,
    casesBelowThreshold: cases
      .filter(c => c.with.score < threshold)
      .map(c => c.name),
    regressedCases: cases
      .filter((_, i) => verdicts[i] === 'regressed')
      .map(c => c.name),
  }
}

/**
 * Process exit code.
 *
 * 2 is reserved for "we stopped early", so a budget or clock ceiling never
 * masquerades as a verdict — a partial run reporting 0 would read as success.
 */
export function exitCodeFor(
  result: SuiteResult,
  options: { failOnRegression: boolean },
): 0 | 1 | 2 {
  if (result.partial) return 2
  if (result.loadErrors.length > 0) return 1
  if (result.cases.length === 0) return 1
  const totals = summarize(result.cases, result.threshold)
  if (totals.casesBelowThreshold.length > 0) return 1
  if (options.failOnRegression && totals.regressed > 0) return 1
  return 0
}
