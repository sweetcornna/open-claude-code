/**
 * The optional LLM grader.
 *
 * Reached only when a case declares a `judge:` block, so a fully deterministic
 * suite provably spends nothing here. It runs through the same
 * {@link AgentRunner} as the cases themselves — one more `occ -p` child, tools
 * stripped — which means it inherits the user's provider and auth with no
 * second API path to keep working.
 *
 * The verdict is a single word rather than a number. Models are poorly
 * calibrated when asked for a 0–1 score and the extra precision would be
 * noise; run-to-run variance is handled by `runs:` and averaging instead.
 * Anything unparseable counts as a failure with the raw reply as the
 * explanation — never as a silent pass.
 */

import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { JudgeSpec } from './caseSchema.js'
import type { AgentRunner } from './agentRunner.js'
import type { AgentRunOutcome, GraderResult } from './types.js'

/** Keeps a long transcript from dominating the judge's context. */
const MAX_EXCERPT_CHARS = 20_000

/**
 * Replaces occ's coding-agent system prompt for the judge turn.
 *
 * Without it the judge inherits the agent persona and opens with "I'll inspect
 * the file first…" instead of a verdict — which fails closed and silently
 * scores every judged case zero.
 */
export const JUDGE_SYSTEM_PROMPT =
  'You are a strict, terse evaluation judge for coding-agent transcripts. ' +
  'You do not have tools and you never ask for more information. ' +
  'You read what you are given and reply in the exact format requested, ' +
  'with no preamble and no commentary.'

function excerpt(text: string): string {
  if (text.length <= MAX_EXCERPT_CHARS) return text
  const half = Math.floor(MAX_EXCERPT_CHARS / 2)
  return `${text.slice(0, half)}\n…[${text.length - MAX_EXCERPT_CHARS} characters elided]…\n${text.slice(-half)}`
}

/**
 * Build the judge turn.
 *
 * Fixed wording, and the only variable parts are the rubric, the task and the
 * transcript — so two runs of the same case put the same bytes in front of the
 * judge. That is as far as reproducibility can be pushed without a temperature
 * knob, which occ does not expose on the CLI.
 */
export function buildJudgePrompt(input: {
  rubric: string
  task: string
  output: string
  toolNames: readonly string[]
}): string {
  const tools =
    input.toolNames.length > 0
      ? input.toolNames.join(', ')
      : '(the agent used no tools)'
  return [
    'You are grading a coding agent transcript against a rubric. Be strict and terse.',
    '',
    '## Rubric',
    input.rubric.trim(),
    '',
    '## Task the agent was given',
    excerpt(input.task.trim()),
    '',
    '## Tools the agent invoked',
    tools,
    '',
    "## Agent's final answer",
    excerpt(input.output.trim()) || '(the agent produced no final answer)',
    '',
    '## Your reply',
    'Reply with exactly two lines and nothing else:',
    'VERDICT: PASS or VERDICT: FAIL',
    'REASON: one sentence',
  ].join('\n')
}

export type JudgeVerdict = { passed: boolean; reason: string }

/**
 * Parse the judge reply.
 *
 * Fails closed: a reply that does not state a verdict is a failure, because
 * treating "the judge went off script" as a pass would quietly inflate scores
 * exactly when the judge is least reliable.
 */
export function parseJudgeVerdict(reply: string): JudgeVerdict {
  const verdict = /^\s*VERDICT:\s*(PASS|FAIL)\b/im.exec(reply)
  const reason = /^\s*REASON:\s*(.+)$/im.exec(reply)
  if (verdict === null) {
    const trimmed = reply.trim()
    return {
      passed: false,
      reason:
        trimmed === ''
          ? 'judge returned an empty reply'
          : `judge reply had no VERDICT line: ${trimmed.slice(0, 300)}`,
    }
  }
  return {
    passed: verdict[1]!.toUpperCase() === 'PASS',
    reason: reason?.[1]?.trim() ?? '(no reason given)',
  }
}

/** Run the judge for one agent outcome and shape it as a grader result. */
export async function runJudge(input: {
  spec: JudgeSpec
  task: string
  outcome: AgentRunOutcome
  runner: AgentRunner
  defaultModel: string
  timeoutMs: number
  maxBudgetUsd?: number
  signal?: AbortSignal
}): Promise<GraderResult> {
  const base = {
    label: 'judge',
    kind: 'judge' as const,
    weight: input.spec.weight,
    withOnly: input.spec.arm === 'with-only',
  }

  // The judge writes nothing, but occ still needs a cwd it can read; an empty
  // throwaway keeps the operator's project out of the judge's reach.
  const cwd = mkdtempSync(join(tmpdir(), 'occ-eval-judge-'))
  try {
    const result = await input.runner.run({
      prompt: buildJudgePrompt({
        rubric: input.spec.rubric,
        task: input.task,
        output: input.outcome.output,
        toolNames: [...new Set(input.outcome.toolCalls.map(c => c.name))],
      }),
      cwd,
      pluginDirs: [],
      model: input.spec.model ?? input.defaultModel,
      allowedTools: [],
      disableTools: true,
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      maxTurns: 1,
      timeoutMs: input.timeoutMs,
      maxBudgetUsd: input.maxBudgetUsd,
      signal: input.signal,
    })
    if (!result.ok) {
      return {
        ...base,
        passed: false,
        detail: `judge call failed: ${result.error ?? 'unknown error'}`,
        judgeCostUsd: result.costUsd,
      }
    }
    const verdict = parseJudgeVerdict(result.output)
    return {
      ...base,
      passed: verdict.passed,
      detail: verdict.reason,
      judgeCostUsd: result.costUsd,
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}
