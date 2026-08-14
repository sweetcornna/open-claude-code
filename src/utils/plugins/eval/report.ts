/**
 * Rendering. Pure functions over {@link SuiteResult} — no fs, no clock.
 *
 * The terminal report is the primary artifact and is always produced. The
 * markdown one exists so a result can be handed to someone else; it is
 * deliberately plain markdown rather than a bespoke HTML document, because the
 * artifact pipeline already knows how to turn markdown into a themed page and
 * a second stylesheet in this repo would be one more thing to keep in sync.
 */

import { caseVerdict, summarize } from './aggregate.js'
import type { CaseResult, EvalPlan, SuiteResult } from './types.js'

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}

/** First failing grader, so the table can say *why* without a second command. */
function noteFor(result: CaseResult): string {
  for (const run of result.with.runs) {
    if (run.error !== undefined) return run.error
  }
  for (const run of result.with.runs) {
    const failed = run.graders
      .filter(g => !g.passed && !g.withOnly)
      .sort((a, b) => b.weight - a.weight)[0]
    if (failed !== undefined) return `${failed.label}: ${failed.detail}`
  }
  return ''
}

/** The human-facing summary printed at the end of every run. */
export function renderTerminalReport(result: SuiteResult): string {
  const totals = summarize(result.cases, result.threshold)
  const lines: string[] = []

  const hasBaseline = result.ablation === 'with-without'
  const nameWidth = Math.max(4, ...result.cases.map(c => c.name.length))

  lines.push(
    pad('CASE', nameWidth) +
      padStart('WITH', 8) +
      (hasBaseline ? padStart('W/OUT', 8) + padStart('Δ', 8) : '') +
      padStart('RUNS', 6) +
      padStart('COST', 10) +
      '  NOTES',
  )
  for (const c of result.cases) {
    const note = noteFor(c)
    lines.push(
      pad(c.name, nameWidth) +
        padStart(c.with.score.toFixed(2), 8) +
        (hasBaseline
          ? padStart(c.without?.score.toFixed(2) ?? '—', 8) +
            padStart(c.delta === undefined ? '—' : signed(c.delta), 8)
          : '') +
        padStart(String(c.with.runs.length), 6) +
        padStart(`$${c.costUsd.toFixed(4)}`, 10) +
        (note === '' ? '' : `  ${note.slice(0, 60)}`),
    )
  }

  lines.push('')
  if (hasBaseline && totals.meanDelta !== undefined) {
    lines.push(
      `Plugin effect: ${signed(totals.meanDelta)} mean Δ — ` +
        `improved ${totals.improved} · flat ${totals.flat} · regressed ${totals.regressed}` +
        ` of ${result.cases.length} case${result.cases.length === 1 ? '' : 's'}`,
    )
  } else if (!hasBaseline) {
    lines.push(
      'No control arm ran (--ablation none), so these scores say how the ' +
        'cases went, not what the plugin changed.',
    )
  }
  lines.push(
    `Score ${totals.overallScore.toFixed(2)} · ` +
      `${totals.casesPassed}/${result.cases.length} at or above threshold ${result.threshold} · ` +
      `$${result.costUsd.toFixed(4)} · ${(result.durationMs / 1000).toFixed(1)}s`,
  )

  if (totals.regressedCases.length > 0) {
    lines.push(`Regressed: ${totals.regressedCases.join(', ')}`)
  }
  if (totals.casesBelowThreshold.length > 0) {
    lines.push(`Below threshold: ${totals.casesBelowThreshold.join(', ')}`)
  }
  if (result.partial) {
    lines.push(`Partial run: ${result.partialReason}. Numbers are incomplete.`)
  }
  if (result.loadErrors.length > 0) {
    lines.push('')
    lines.push(`${result.loadErrors.length} case file(s) failed to load:`)
    for (const e of result.loadErrors) lines.push(`  ${e.file}: ${e.error}`)
  }
  return lines.join('\n')
}

/** `--dry-run`: what a real run would cost, before spending any of it. */
export function renderPlan(
  plan: EvalPlan,
  context: { threshold: number },
): string {
  const lines: string[] = [
    `Would run ${plan.cases.length} case(s) across ${plan.arms.length} arm(s): ${plan.arms.join(', ')}`,
    '',
  ]
  const nameWidth = Math.max(4, ...plan.cases.map(c => c.name.length))
  lines.push(
    pad('CASE', nameWidth) +
      padStart('RUNS', 6) +
      padStart('AGENT', 8) +
      padStart('JUDGE', 8),
  )
  for (const c of plan.cases) {
    lines.push(
      pad(c.name, nameWidth) +
        padStart(String(c.runs), 6) +
        padStart(String(c.agentCalls), 8) +
        padStart(String(c.judgeCalls), 8),
    )
  }
  lines.push('')
  lines.push(
    `Model invocations: ${plan.totalAgentCalls} agent + ${plan.totalJudgeCalls} judge = ` +
      `${plan.totalAgentCalls + plan.totalJudgeCalls} total`,
  )
  lines.push(`Threshold: ${context.threshold}`)
  const denied = plan.cases.filter(c => c.deniedTools.length > 0)
  if (denied.length > 0) {
    lines.push('')
    lines.push(
      'Tools these cases asked for but do not have (pass --allow-tools to grant):',
    )
    for (const c of denied)
      lines.push(`  ${c.name}: ${c.deniedTools.join(', ')}`)
  }
  lines.push('')
  lines.push('Nothing was run. Drop --dry-run to execute.')
  return lines.join('\n')
}

function mdEscape(text: string): string {
  return text.replace(/\|/g, '\\|')
}

/** Shareable markdown, suitable for handing to the artifact pipeline. */
export function renderMarkdownReport(result: SuiteResult): string {
  const totals = summarize(result.cases, result.threshold)
  const hasBaseline = result.ablation === 'with-without'
  const lines: string[] = [
    `# Plugin eval — ${result.pluginId ?? result.root}`,
    '',
    `- Started: ${result.startedAt}`,
    `- Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    `- Cost: $${result.costUsd.toFixed(4)}`,
    `- Ablation: ${result.ablation}`,
    `- Threshold: ${result.threshold}`,
    ...(result.model === undefined ? [] : [`- Model: ${result.model}`]),
    ...(result.cases.some(c =>
      c.with.runs.some(r => r.graders.some(g => g.kind === 'judge')),
    )
      ? [`- Judge model: ${result.judgeModel}`]
      : []),
    '',
  ]

  if (hasBaseline && totals.meanDelta !== undefined) {
    lines.push(
      `**Plugin effect: ${signed(totals.meanDelta)} mean Δ** — improved ${totals.improved}, ` +
        `flat ${totals.flat}, regressed ${totals.regressed} of ${result.cases.length}.`,
    )
  } else {
    lines.push(
      '**No control arm ran.** These scores describe the cases, not the plugin’s effect.',
    )
  }
  if (result.partial) {
    lines.push('')
    lines.push(
      `> Partial run (${result.partialReason}) — numbers are incomplete.`,
    )
  }
  lines.push('')

  lines.push(
    hasBaseline
      ? '| Case | With | Without | Δ | Runs | Cost |'
      : '| Case | Score | Runs | Cost |',
  )
  lines.push(
    hasBaseline
      ? '| --- | ---: | ---: | ---: | ---: | ---: |'
      : '| --- | ---: | ---: | ---: |',
  )
  for (const c of result.cases) {
    lines.push(
      hasBaseline
        ? `| ${mdEscape(c.name)} | ${c.with.score.toFixed(2)} | ${c.without?.score.toFixed(2) ?? '—'} | ` +
            `${c.delta === undefined ? '—' : signed(c.delta)} | ${c.with.runs.length} | $${c.costUsd.toFixed(4)} |`
        : `| ${mdEscape(c.name)} | ${c.with.score.toFixed(2)} | ${c.with.runs.length} | $${c.costUsd.toFixed(4)} |`,
    )
  }
  lines.push('')

  for (const c of result.cases) {
    lines.push(`## ${c.name}`)
    lines.push('')
    lines.push(`Verdict: **${caseVerdict(c)}**`)
    lines.push('')
    for (const arm of ['with', 'without'] as const) {
      const aggregate = arm === 'with' ? c.with : c.without
      if (aggregate === undefined) continue
      lines.push(
        `### ${arm === 'with' ? 'With plugin' : 'Without plugin (control)'}`,
      )
      lines.push('')
      for (const run of aggregate.runs) {
        lines.push(
          `- Run ${run.index + 1}: score ${run.score.toFixed(2)}, ${run.numTurns} turn(s), ` +
            `$${(run.costUsd + run.judgeCostUsd).toFixed(4)}` +
            (run.error === undefined
              ? ''
              : ` — **error:** ${mdEscape(run.error)}`),
        )
        for (const g of run.graders) {
          const mark = g.passed ? '✓' : '✗'
          const tag = g.withOnly ? ' _(with-only, not scored)_' : ''
          lines.push(
            `  - ${mark} \`${mdEscape(g.label)}\`${tag} — ${mdEscape(g.detail)}`,
          )
        }
      }
      lines.push('')
    }
  }

  if (result.loadErrors.length > 0) {
    lines.push('## Case files that failed to load')
    lines.push('')
    for (const e of result.loadErrors) {
      lines.push(`- \`${mdEscape(e.file)}\`: ${mdEscape(e.error)}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}
