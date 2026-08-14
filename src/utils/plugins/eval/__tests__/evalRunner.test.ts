/**
 * Orchestration: the ablation arms, the cost/time/interrupt ceilings, dry-run
 * accounting and score aggregation.
 *
 * Everything here runs against a fake {@link AgentRunner} injected through
 * `runSuite`, so no model is ever contacted and no module is ever mocked. The
 * fake records the requests it receives, which is how the "the two arms differ
 * in exactly one field" property gets asserted rather than assumed.
 */

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import type { AgentRunner, AgentRunRequest } from '../agentRunner.js'
import {
  aggregateArm,
  caseVerdict,
  exitCodeFor,
  summarize,
} from '../aggregate.js'
import { EvalCaseSchema } from '../caseSchema.js'
import { checkBudget, createWorkRoot, planSuite, runSuite } from '../runner.js'
import { scoreGraders } from '../types.js'
import type {
  AgentRunOutcome,
  CaseResult,
  LoadedCase,
  RunResult,
  SuiteResult,
} from '../types.js'

/** Records every request and returns whatever the scenario dictates. */
class FakeRunner implements AgentRunner {
  readonly requests: AgentRunRequest[] = []
  constructor(
    private readonly reply: (
      request: AgentRunRequest,
      callIndex: number,
    ) => Partial<AgentRunOutcome>,
  ) {}

  async run(request: AgentRunRequest): Promise<AgentRunOutcome> {
    const index = this.requests.length
    this.requests.push(request)
    return {
      ok: true,
      output: '',
      toolCalls: [],
      costUsd: 0,
      numTurns: 1,
      durationMs: 1,
      ...this.reply(request, index),
    }
  }
}

const DEFAULT_SPEC = EvalCaseSchema.parse({
  prompt: 'do the thing',
  assert: [{ type: 'output_matches', pattern: 'done' }],
})

function makeCase(overrides: Partial<LoadedCase> = {}): LoadedCase {
  return {
    name: 'sample',
    dir: '/cases/sample',
    file: '/cases/sample/case.yaml',
    spec: DEFAULT_SPEC,
    prompt: 'do the thing',
    allowedTools: ['Read'],
    deniedTools: [],
    ...overrides,
  }
}

function baseOptions(runner: AgentRunner, workRoot: string) {
  return {
    root: '/cases',
    cases: [makeCase()],
    loadErrors: [],
    ablation: 'with-without' as const,
    pluginRoot: '/plugins/mine',
    pluginId: 'mine',
    runner,
    judgeModel: 'haiku',
    threshold: 1,
    maxCostUsd: 5,
    maxDurationMs: 1_800_000,
    runTimeoutMs: 120_000,
    allowCommands: false,
    keepTemp: false,
    onLine: () => {},
    workRoot,
  }
}

function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'occ-eval-run-'))
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }))
}

describe('ablation', () => {
  test('the two arms differ in exactly one field', async () => {
    await withTempRoot(async workRoot => {
      const runner = new FakeRunner(() => ({ output: 'done' }))
      await runSuite(baseOptions(runner, workRoot))

      expect(runner.requests).toHaveLength(2)
      const [withArm, withoutArm] = runner.requests
      expect(withArm!.pluginDirs).toEqual(['/plugins/mine'])
      expect(withoutArm!.pluginDirs).toEqual([])

      // Everything else must match, or the delta measures something else.
      const strip = (r: AgentRunRequest): Record<string, unknown> => {
        const { pluginDirs: _p, cwd: _c, traceDir: _t, ...rest } = r
        return rest as unknown as Record<string, unknown>
      }
      expect(strip(withArm!)).toEqual(strip(withoutArm!))
    })
  })

  test('--ablation none runs only the treatment arm', async () => {
    await withTempRoot(async workRoot => {
      const runner = new FakeRunner(() => ({ output: 'done' }))
      const result = await runSuite({
        ...baseOptions(runner, workRoot),
        ablation: 'none',
      })
      expect(runner.requests).toHaveLength(1)
      expect(result.cases[0]!.without).toBeUndefined()
      expect(result.cases[0]!.delta).toBeUndefined()
    })
  })

  test('the delta reflects a plugin that actually helps', async () => {
    await withTempRoot(async workRoot => {
      // The treatment arm answers correctly; the control arm does not.
      const runner = new FakeRunner(request => ({
        output: request.pluginDirs.length > 0 ? 'done' : 'no idea',
      }))
      const result = await runSuite(baseOptions(runner, workRoot))
      const only = result.cases[0]!
      expect(only.with.score).toBe(1)
      expect(only.without!.score).toBe(0)
      expect(only.delta).toBe(1)
      expect(caseVerdict(only)).toBe('improved')
    })
  })

  test('a regression is reported as one', async () => {
    await withTempRoot(async workRoot => {
      const runner = new FakeRunner(request => ({
        output: request.pluginDirs.length > 0 ? 'no idea' : 'done',
      }))
      const result = await runSuite(baseOptions(runner, workRoot))
      expect(result.cases[0]!.delta).toBe(-1)
      expect(caseVerdict(result.cases[0]!)).toBe('regressed')
    })
  })
})

describe('cost ceiling', () => {
  test('stops before launching a run once the budget is spent', async () => {
    await withTempRoot(async workRoot => {
      const runner = new FakeRunner(() => ({ output: 'done', costUsd: 0.6 }))
      const result = await runSuite({
        ...baseOptions(runner, workRoot),
        cases: [
          makeCase({ name: 'a' }),
          makeCase({ name: 'b' }),
          makeCase({ name: 'c' }),
        ],
        maxCostUsd: 1,
      })
      // First run spends 0.6, second brings the total to 1.2 >= 1, so the
      // third never launches.
      expect(runner.requests).toHaveLength(2)
      expect(result.partial).toBe(true)
      expect(result.partialReason).toBe('cost_ceiling')
    })
  })

  test('each run is handed the remaining budget so one cannot overshoot', async () => {
    await withTempRoot(async workRoot => {
      const runner = new FakeRunner(() => ({ output: 'done', costUsd: 0.25 }))
      await runSuite({
        ...baseOptions(runner, workRoot),
        maxCostUsd: 1,
      })
      expect(runner.requests[0]!.maxBudgetUsd).toBe(1)
      expect(runner.requests[1]!.maxBudgetUsd).toBe(0.75)
    })
  })

  test('a partial suite exits 2, never 0', async () => {
    await withTempRoot(async workRoot => {
      const runner = new FakeRunner(() => ({ output: 'done', costUsd: 5 }))
      const result = await runSuite({
        ...baseOptions(runner, workRoot),
        maxCostUsd: 1,
      })
      expect(result.partial).toBe(true)
      expect(exitCodeFor(result, { failOnRegression: false })).toBe(2)
    })
  })
})

describe('time ceiling', () => {
  test('stops once the clock passes the deadline', async () => {
    await withTempRoot(async workRoot => {
      let clock = 1_000_000
      const runner = new FakeRunner(() => {
        clock += 40_000
        return { output: 'done' }
      })
      const result = await runSuite({
        ...baseOptions(runner, workRoot),
        cases: [makeCase({ name: 'a' }), makeCase({ name: 'b' })],
        maxDurationMs: 60_000,
        now: () => clock,
      })
      expect(runner.requests.length).toBeLessThan(4)
      expect(result.partial).toBe(true)
      expect(result.partialReason).toBe('time_ceiling')
    })
  })

  test('a run never gets a timeout longer than the time left', async () => {
    await withTempRoot(async workRoot => {
      const clock = 1_000_000
      const runner = new FakeRunner(() => ({ output: 'done' }))
      await runSuite({
        ...baseOptions(runner, workRoot),
        maxDurationMs: 30_000,
        runTimeoutMs: 120_000,
        now: () => clock,
      })
      expect(runner.requests[0]!.timeoutMs).toBe(30_000)
    })
  })
})

describe('interrupt', () => {
  test('an aborted signal stops the suite and marks it partial', async () => {
    await withTempRoot(async workRoot => {
      const controller = new AbortController()
      controller.abort()
      const runner = new FakeRunner(() => ({ output: 'done' }))
      const result = await runSuite({
        ...baseOptions(runner, workRoot),
        signal: controller.signal,
      })
      expect(runner.requests).toHaveLength(0)
      expect(result.partialReason).toBe('interrupted')
    })
  })

  test('checkBudget ranks interrupt above the other ceilings', () => {
    expect(
      checkBudget(
        { spent: 100, deadline: 0 },
        { maxCostUsd: 1, now: 5, aborted: true },
      ),
    ).toBe('interrupted')
    expect(
      checkBudget(
        { spent: 100, deadline: 1e9 },
        { maxCostUsd: 1, now: 5, aborted: false },
      ),
    ).toBe('cost_ceiling')
    expect(
      checkBudget(
        { spent: 0, deadline: 0 },
        { maxCostUsd: 1, now: 5, aborted: false },
      ),
    ).toBe('time_ceiling')
    expect(
      checkBudget(
        { spent: 0, deadline: 1e9 },
        { maxCostUsd: 1, now: 5, aborted: false },
      ),
    ).toBeUndefined()
  })
})

describe('dry run planning', () => {
  test('counts agent calls as runs × arms and judge calls only when declared', () => {
    const cheap = makeCase({ name: 'cheap' })
    const judged = makeCase({
      name: 'judged',
      spec: EvalCaseSchema.parse({
        prompt: 'x',
        runs: 3,
        assert: [{ type: 'output_matches', pattern: 'a' }],
        judge: { rubric: 'be good' },
      }),
    })
    const plan = planSuite([cheap, judged], 'with-without')
    expect(plan.arms).toEqual(['with', 'without'])
    expect(plan.cases[0]!.agentCalls).toBe(2)
    expect(plan.cases[0]!.judgeCalls).toBe(0)
    expect(plan.cases[1]!.agentCalls).toBe(6)
    expect(plan.cases[1]!.judgeCalls).toBe(6)
    expect(plan.totalAgentCalls).toBe(8)
    expect(plan.totalJudgeCalls).toBe(6)
  })

  test('a suite with no judge block plans zero judge calls', () => {
    const plan = planSuite([makeCase()], 'with-without')
    expect(plan.totalJudgeCalls).toBe(0)
  })

  test('--ablation none halves the agent calls', () => {
    expect(planSuite([makeCase()], 'none').totalAgentCalls).toBe(1)
    expect(planSuite([makeCase()], 'with-without').totalAgentCalls).toBe(2)
  })
})

describe('scoring', () => {
  const grader = (over: Partial<RunResult['graders'][number]>) => ({
    label: 'g',
    kind: 'assert' as const,
    passed: true,
    weight: 1,
    withOnly: false,
    detail: '',
    ...over,
  })

  test('with-only graders are excluded from the score', () => {
    expect(
      scoreGraders([
        grader({ passed: true, withOnly: true }),
        grader({ passed: false }),
      ]),
    ).toBe(0)
    expect(
      scoreGraders([
        grader({ passed: true, withOnly: true }),
        grader({ passed: true }),
      ]),
    ).toBe(1)
  })

  test('weights change the fraction', () => {
    expect(
      scoreGraders([
        grader({ passed: true, weight: 3 }),
        grader({ passed: false, weight: 1 }),
      ]),
    ).toBe(0.75)
  })

  test('a run with no scoreable graders scores 0, not NaN', () => {
    expect(scoreGraders([grader({ withOnly: true })])).toBe(0)
    expect(scoreGraders([])).toBe(0)
  })

  test('aggregateArm means the scores and counts only perfect runs as passes', () => {
    const run = (score: number): RunResult => ({
      arm: 'with',
      index: 0,
      score,
      graders: [],
      costUsd: 0,
      judgeCostUsd: 0,
      durationMs: 0,
      numTurns: 0,
    })
    const arm = aggregateArm([run(1), run(0.5), run(1)])
    expect(arm.score).toBeCloseTo(0.8333, 3)
    expect(arm.passRate).toBeCloseTo(2 / 3, 5)
  })

  test('a failed agent run scores 0 and never runs graders', async () => {
    await withTempRoot(async workRoot => {
      const runner = new FakeRunner(() => ({
        ok: false,
        error: 'timed out after 120s',
      }))
      const result = await runSuite(baseOptions(runner, workRoot))
      expect(result.cases[0]!.with.score).toBe(0)
      expect(result.cases[0]!.with.runs[0]!.graders).toHaveLength(0)
      expect(result.cases[0]!.with.runs[0]!.error).toContain('timed out')
    })
  })
})

describe('verdicts and exit codes', () => {
  const caseResult = (over: Partial<CaseResult>): CaseResult => ({
    name: 'c',
    dir: '/c',
    with: { score: 1, passRate: 1, runs: [] },
    costUsd: 0,
    ...over,
  })
  const suite = (over: Partial<SuiteResult>): SuiteResult => ({
    schemaVersion: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 0,
    root: '/r',
    ablation: 'with-without',
    threshold: 1,
    judgeModel: 'haiku',
    cases: [caseResult({})],
    loadErrors: [],
    costUsd: 0,
    partial: false,
    ...over,
  })

  test('floating-point dust reads as flat, not as an effect', () => {
    expect(caseVerdict(caseResult({ delta: 0.0001 }))).toBe('flat')
    expect(caseVerdict(caseResult({ delta: 0.5 }))).toBe('improved')
    expect(caseVerdict(caseResult({ delta: undefined }))).toBe('no-baseline')
  })

  test('a clean suite exits 0', () => {
    expect(exitCodeFor(suite({}), { failOnRegression: false })).toBe(0)
  })

  test('a case below threshold exits 1', () => {
    const result = suite({
      cases: [caseResult({ with: { score: 0.5, passRate: 0, runs: [] } })],
    })
    expect(exitCodeFor(result, { failOnRegression: false })).toBe(1)
  })

  test('load errors exit 1 even when every loaded case passed', () => {
    const result = suite({ loadErrors: [{ file: 'a', error: 'bad' }] })
    expect(exitCodeFor(result, { failOnRegression: false })).toBe(1)
  })

  test('--fail-on-regression turns a negative delta into a non-zero exit', () => {
    const result = suite({ cases: [caseResult({ delta: -0.4 })] })
    expect(exitCodeFor(result, { failOnRegression: false })).toBe(0)
    expect(exitCodeFor(result, { failOnRegression: true })).toBe(1)
  })

  test('summarize counts each verdict bucket', () => {
    const totals = summarize(
      [
        caseResult({ name: 'up', delta: 0.5 }),
        caseResult({ name: 'flat', delta: 0 }),
        caseResult({ name: 'down', delta: -0.5 }),
      ],
      1,
    )
    expect(totals.improved).toBe(1)
    expect(totals.flat).toBe(1)
    expect(totals.regressed).toBe(1)
    expect(totals.regressedCases).toEqual(['down'])
    expect(totals.meanDelta).toBeCloseTo(0, 5)
  })
})

describe('workspace lifecycle', () => {
  test('--keep-temp preserves the workspace, the default cleans it up', async () => {
    await withTempRoot(async workRoot => {
      const kept = new FakeRunner(() => ({ output: 'done' }))
      const keptResult = await runSuite({
        ...baseOptions(kept, workRoot),
        ablation: 'none',
        keepTemp: true,
      })
      expect(keptResult.cases[0]!.with.runs[0]!.workspacePath).toBeDefined()

      const swept = new FakeRunner(() => ({ output: 'done' }))
      const sweptResult = await runSuite({
        ...baseOptions(swept, workRoot),
        ablation: 'none',
        keepTemp: false,
      })
      expect(sweptResult.cases[0]!.with.runs[0]!.workspacePath).toBeUndefined()
    })
  })

  test('the default sandbox root is outside the occ config dir', () => {
    // Regression guard: occ refuses tool writes under its own config root, so
    // a sandbox at ~/.occ/... makes every Write fail with a misleading
    // "don't ask mode" denial and every case score 0.
    const root = createWorkRoot()
    try {
      expect(root.startsWith(tmpdir())).toBe(true)
      expect(root).not.toContain(`${sep}.occ${sep}`)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('each run gets its own deterministic workspace path', async () => {
    await withTempRoot(async workRoot => {
      const runner = new FakeRunner(() => ({ output: 'done' }))
      await runSuite({
        ...baseOptions(runner, workRoot),
        cases: [
          makeCase({
            name: 'repeat',
            spec: EvalCaseSchema.parse({
              prompt: 'x',
              runs: 2,
              assert: [{ type: 'output_matches', pattern: 'done' }],
            }),
          }),
        ],
      })
      const paths = runner.requests.map(r => r.cwd)
      expect(new Set(paths).size).toBe(paths.length)
      expect(paths[0]).toContain(join('repeat', 'with', 'run-1'))
      expect(paths[1]).toContain(join('repeat', 'with', 'run-2'))
      expect(paths[2]).toContain(join('repeat', 'without', 'run-1'))
    })
  })
})
