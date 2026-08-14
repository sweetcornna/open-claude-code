/**
 * The wire between occ's print mode and the eval: child argv, stream-json
 * parsing, the judge protocol, and report rendering.
 *
 * `buildAgentArgs` and `consumeStreamLine` are the two places where a silent
 * drift in occ's CLI surface would turn every eval into a mysterious zero, so
 * they are pinned here rather than only exercised end to end.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildAgentArgs,
  consumeStreamLine,
  evalChildEnv,
  outcomeFromStream,
} from '../agentRunner.js'
import type { AgentRunRequest } from '../agentRunner.js'
import {
  buildJudgePrompt,
  JUDGE_SYSTEM_PROMPT,
  parseJudgeVerdict,
} from '../judge.js'
import {
  renderMarkdownReport,
  renderPlan,
  renderTerminalReport,
} from '../report.js'
import { planSuite } from '../runner.js'
import type { CaseResult, SuiteResult, ToolCall } from '../types.js'

const REQUEST: AgentRunRequest = {
  prompt: 'do the thing',
  cwd: '/ws',
  pluginDirs: ['/plugins/mine'],
  allowedTools: ['Read', 'Write'],
  maxTurns: 12,
  timeoutMs: 120_000,
}

describe('child argv', () => {
  test('the prompt sits immediately after -p, ahead of every flag', () => {
    const args = buildAgentArgs(REQUEST)
    expect(args[0]).toBe('-p')
    expect(args[1]).toBe('do the thing')
    // A variadic option directly before a bare positional would eat it.
    expect(args.indexOf('--allowed-tools')).toBeGreaterThan(1)
  })

  test('asks for the stream-json transcript, which requires --verbose', () => {
    const args = buildAgentArgs(REQUEST)
    expect(args).toContain('--output-format')
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json')
    expect(args).toContain('--verbose')
  })

  test('runs unattended without granting anything by default', () => {
    const args = buildAgentArgs(REQUEST)
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).toContain('--strict-mcp-config')
  })

  test('allowed tools go over as one comma-joined token', () => {
    const args = buildAgentArgs(REQUEST)
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe('Read,Write')
  })

  test('--plugin-dir is repeated per directory, never space-separated', () => {
    const args = buildAgentArgs({
      ...REQUEST,
      pluginDirs: ['/a', '/b'],
    })
    expect(args.filter(a => a === '--plugin-dir')).toHaveLength(2)
    expect(args[args.indexOf('--plugin-dir') + 1]).toBe('/a')
  })

  test('the control arm passes no --plugin-dir at all', () => {
    expect(buildAgentArgs({ ...REQUEST, pluginDirs: [] })).not.toContain(
      '--plugin-dir',
    )
  })

  test('the per-run budget is forwarded to the child', () => {
    const args = buildAgentArgs({ ...REQUEST, maxBudgetUsd: 0.75 })
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.75')
  })

  test('disableTools strips the built-in set instead of listing tools', () => {
    const args = buildAgentArgs({ ...REQUEST, disableTools: true })
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args).not.toContain('--allowed-tools')
  })

  test('a system prompt replaces the default one when given', () => {
    expect(buildAgentArgs(REQUEST)).not.toContain('--system-prompt')
    const args = buildAgentArgs({ ...REQUEST, systemPrompt: 'be terse' })
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('be terse')
  })

  test('the shared child env suppresses machine-specific context', () => {
    const env = evalChildEnv({ PATH: '/bin' })
    // Without this the operator's home CLAUDE.md would join every run.
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1')
    expect(env.DISABLE_AUTOUPDATER).toBe('1')
    expect(env.PATH).toBe('/bin')
  })

  test('never sets CI, which would divert the child away from keychain auth', () => {
    // Regression guard: with CI=1 every child exits 0 having produced nothing,
    // because auth.ts stops consulting the keychain and OAuth. The failure is
    // silent — an empty result and a zero score, with no error to explain it.
    expect(evalChildEnv({}).CI).toBeUndefined()
    expect(evalChildEnv({ CI: 'true' }).CI).toBe('true')
  })
})

describe('stream-json parsing', () => {
  const collect = (lines: string[]) => {
    const acc: { toolCalls: ToolCall[]; result?: Record<string, unknown> } = {
      toolCalls: [],
    }
    for (const line of lines) consumeStreamLine(line, acc)
    return acc
  }

  test('tool_use blocks become tool calls', () => {
    const acc = collect([
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'working' },
            { type: 'tool_use', name: 'Write', input: { file_path: 'a.md' } },
          ],
        },
      }),
    ])
    expect(acc.toolCalls).toEqual([
      { name: 'Write', inputJson: '{"file_path":"a.md"}' },
    ])
  })

  test('the result message is captured', () => {
    const acc = collect([
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: 'all done',
        total_cost_usd: 0.02,
        num_turns: 4,
      }),
    ])
    expect(acc.result?.result).toBe('all done')
  })

  test('malformed and unrelated lines are ignored, not fatal', () => {
    const acc = collect(['not json', '{"type":"system"}', '[]', 'null'])
    expect(acc.toolCalls).toEqual([])
    expect(acc.result).toBeUndefined()
  })
})

describe('outcome shaping', () => {
  test('a success result yields a graded run', () => {
    const outcome = outcomeFromStream(
      {
        toolCalls: [],
        result: {
          subtype: 'success',
          is_error: false,
          result: 'done',
          total_cost_usd: 0.03,
          num_turns: 2,
          duration_ms: 900,
        },
      },
      { durationMs: 1000 },
    )
    expect(outcome.ok).toBe(true)
    expect(outcome.output).toBe('done')
    expect(outcome.costUsd).toBe(0.03)
    expect(outcome.durationMs).toBe(900)
  })

  test('an error subtype is not ok, but its cost still counts', () => {
    const outcome = outcomeFromStream(
      {
        toolCalls: [],
        result: {
          subtype: 'error_max_turns',
          is_error: true,
          total_cost_usd: 0.04,
          num_turns: 12,
        },
      },
      { durationMs: 10 },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('error_max_turns')
    // Spent money must reach the budget even when the run failed.
    expect(outcome.costUsd).toBe(0.04)
  })

  test('a run that produced no result message is an error', () => {
    const outcome = outcomeFromStream({ toolCalls: [] }, { durationMs: 5 })
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('no result message')
  })

  test('a timeout wins over whatever the stream contained', () => {
    const outcome = outcomeFromStream(
      { toolCalls: [], result: { subtype: 'success', result: 'done' } },
      { durationMs: 120_000, error: 'timed out after 120s' },
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toBe('timed out after 120s')
  })
})

describe('judge protocol', () => {
  test('parses a well-formed verdict', () => {
    expect(
      parseJudgeVerdict('VERDICT: PASS\nREASON: it did the thing'),
    ).toEqual({ passed: true, reason: 'it did the thing' })
    expect(parseJudgeVerdict('VERDICT: FAIL\nREASON: nope')).toEqual({
      passed: false,
      reason: 'nope',
    })
  })

  test('is case- and whitespace-tolerant', () => {
    expect(parseJudgeVerdict('  verdict:  pass \nreason: fine').passed).toBe(
      true,
    )
  })

  test('fails closed when the judge goes off script', () => {
    expect(parseJudgeVerdict('I think it was pretty good!').passed).toBe(false)
    expect(parseJudgeVerdict('').passed).toBe(false)
    expect(parseJudgeVerdict('').reason).toContain('empty')
  })

  test('a missing reason does not turn a verdict into a failure', () => {
    expect(parseJudgeVerdict('VERDICT: PASS')).toEqual({
      passed: true,
      reason: '(no reason given)',
    })
  })

  test('the prompt is a pure function of its inputs', () => {
    const args = {
      rubric: 'be good',
      task: 'do it',
      output: 'did it',
      toolNames: ['Write'],
    }
    expect(buildJudgePrompt(args)).toBe(buildJudgePrompt(args))
    expect(buildJudgePrompt(args)).toContain('be good')
    expect(buildJudgePrompt(args)).toContain('VERDICT: PASS')
  })

  test('the judge is told it has no tools and must not preamble', () => {
    // Regression guard: on occ's default coding-agent prompt the judge replies
    // "I'll inspect NOTES.md first…", which has no VERDICT line, fails closed,
    // and silently scores every judged case zero.
    expect(JUDGE_SYSTEM_PROMPT).toContain('do not have tools')
    expect(JUDGE_SYSTEM_PROMPT).toContain('no preamble')
  })

  test('a long transcript is elided rather than sent whole', () => {
    const prompt = buildJudgePrompt({
      rubric: 'r',
      task: 't',
      output: 'x'.repeat(100_000),
      toolNames: [],
    })
    expect(prompt.length).toBeLessThan(40_000)
    expect(prompt).toContain('elided')
  })
})

describe('rendering', () => {
  const caseResult = (over: Partial<CaseResult>): CaseResult => ({
    name: 'adds-changelog',
    dir: '/c',
    with: {
      score: 1,
      passRate: 1,
      runs: [
        {
          arm: 'with',
          index: 0,
          score: 1,
          graders: [
            {
              label: 'file_exists CHANGELOG.md',
              kind: 'assert',
              passed: true,
              weight: 1,
              withOnly: false,
              detail: 'file is present',
            },
          ],
          costUsd: 0.02,
          judgeCostUsd: 0,
          durationMs: 1000,
          numTurns: 3,
        },
      ],
    },
    without: { score: 0, passRate: 0, runs: [] },
    delta: 1,
    costUsd: 0.04,
    ...over,
  })

  const suite: SuiteResult = {
    schemaVersion: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 12_000,
    root: '/plugin/evals',
    ablation: 'with-without',
    pluginId: 'my-plugin',
    threshold: 1,
    judgeModel: 'haiku',
    cases: [caseResult({})],
    loadErrors: [],
    costUsd: 0.04,
    partial: false,
  }

  test('the terminal report leads with the ablation delta', () => {
    const text = renderTerminalReport(suite)
    expect(text).toContain('W/OUT')
    expect(text).toContain('Plugin effect: +1.00 mean Δ')
    expect(text).toContain('improved 1')
  })

  test('without a control arm the report says so instead of implying an effect', () => {
    const text = renderTerminalReport({
      ...suite,
      ablation: 'none',
      cases: [caseResult({ without: undefined, delta: undefined })],
    })
    expect(text).toContain('No control arm ran')
    expect(text).not.toContain('W/OUT')
  })

  test('a partial run is flagged so its numbers are not read as final', () => {
    const text = renderTerminalReport({
      ...suite,
      partial: true,
      partialReason: 'cost_ceiling',
    })
    expect(text).toContain('Partial run: cost_ceiling')
  })

  test('load errors are listed with their reason', () => {
    const text = renderTerminalReport({
      ...suite,
      loadErrors: [{ file: '/c/bad/case.yaml', error: 'prompt is empty' }],
    })
    expect(text).toContain('/c/bad/case.yaml')
    expect(text).toContain('prompt is empty')
  })

  test('the dry-run plan separates agent calls from judge calls and spends nothing', () => {
    const plan = planSuite(
      [
        {
          name: 'a',
          dir: '/a',
          file: '/a/case.yaml',
          spec: { runs: 2, judge: undefined } as never,
          prompt: 'p',
          allowedTools: [],
          deniedTools: ['Bash'],
        },
      ],
      'with-without',
    )
    const text = renderPlan(plan, { threshold: 1 })
    expect(text).toContain('4 agent + 0 judge')
    expect(text).toContain('--allow-tools')
    expect(text).toContain('Nothing was run')
  })

  test('the markdown report records per-grader detail', () => {
    const md = renderMarkdownReport(suite)
    expect(md).toContain('# Plugin eval — my-plugin')
    expect(md).toContain('**Plugin effect: +1.00 mean Δ**')
    expect(md).toContain('file_exists CHANGELOG.md')
    expect(md).toContain('Without plugin (control)')
  })

  test('a with-only grader is labelled as unscored in the markdown', () => {
    const md = renderMarkdownReport({
      ...suite,
      cases: [
        caseResult({
          with: {
            score: 1,
            passRate: 1,
            runs: [
              {
                arm: 'with',
                index: 0,
                score: 1,
                graders: [
                  {
                    label: 'skill_used changelog',
                    kind: 'assert',
                    passed: true,
                    weight: 1,
                    withOnly: true,
                    detail: 'invoked 1×',
                  },
                ],
                costUsd: 0,
                judgeCostUsd: 0,
                durationMs: 0,
                numTurns: 1,
              },
            ],
          },
        }),
      ],
    })
    expect(md).toContain('not scored')
  })
})
