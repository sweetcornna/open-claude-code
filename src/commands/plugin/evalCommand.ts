/**
 * `occ plugin eval` — does this plugin actually make the model better?
 *
 * Registration lives next to the handler, following `registerPluginDetailsCommand`.
 *
 * WHAT THIS COMMAND IS FOR
 *
 * Every case runs twice: once with the plugin loaded, once without. The
 * reported headline is the difference. A suite without that control arm would
 * just be a test runner that happens to call a model — it could tell you the
 * cases pass, but not that the plugin had anything to do with it.
 *
 * IT IS A DEVELOPER TOOL, NOT A CI STEP. It spends real money and real minutes
 * on every invocation, which is why the ceilings below are defaults rather than
 * options and why `--dry-run` exists.
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handlers intentionally exit */

import type { Command as CommanderCommand } from '@commander-js/extra-typings'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { setUseCoworkPlugins } from '../../bootstrap/state.js'
import { cliError, cliOk } from '../../cli/exit.js'
import { BIN_NAME } from '../../constants/brand.js'
import { occConfigPath } from '../../config/paths.js'
import { getOriginalCwd } from '../../bootstrap/state/session.js'
import { jsonStringify } from '../../utils/telemetry/slowOperations.js'
import { exitCodeFor } from '../../utils/plugins/eval/aggregate.js'
import { SubprocessAgentRunner } from '../../utils/plugins/eval/agentRunner.js'
import {
  discoverCases,
  findPluginManifest,
  resolveEvalsRoot,
} from '../../utils/plugins/eval/discovery.js'
import { scaffoldCase } from '../../utils/plugins/eval/init.js'
import {
  renderMarkdownReport,
  renderPlan,
  renderTerminalReport,
} from '../../utils/plugins/eval/report.js'
import {
  DEFAULT_JUDGE_MODEL,
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_THRESHOLD,
  planSuite,
  runSuite,
} from '../../utils/plugins/eval/runner.js'
import type { AblationMode } from '../../utils/plugins/eval/types.js'
import { loadAllPlugins } from '../../utils/plugins/pluginLoader.js'
import type { LoadedPlugin } from '../../types/plugin.js'
import { resolvePluginByName } from './detailsCommand.js'

export type EvalOptions = {
  case?: string
  tag?: string[]
  runs?: number
  model?: string
  judgeModel?: string
  threshold?: number
  ablation?: string
  maxCostUsd?: number
  maxDuration?: number
  timeout?: number
  allowTools?: string[]
  allowAssertCommands?: boolean
  dryRun?: boolean
  keepTemp?: boolean
  failOnRegression?: boolean
  json?: string | boolean
  report?: string | boolean
  publish?: boolean
  cowork?: boolean
}

/**
 * Where the plugin under test lives, and whether the control arm is honest.
 *
 * The second half matters more than it looks. `mergePluginSources` lets a
 * `--plugin-dir` copy override an installed plugin of the same name, so if the
 * plugin under test is *also* installed, the "without" arm still loads the
 * installed copy and the delta silently becomes "dev tree vs released version"
 * instead of "plugin vs no plugin". Refusing beats reporting a number that
 * means something other than what its label says.
 */
export type EvalTarget =
  | { kind: 'path'; root: string; pluginRoot?: string; pluginId?: string }
  | { kind: 'error'; message: string }

export function resolveEvalTarget(
  target: string,
  installed: readonly LoadedPlugin[],
  cwd: string,
): EvalTarget {
  const asPath = resolve(cwd, target)
  const evalsRoot = resolveEvalsRoot(asPath)

  if (evalsRoot !== null) {
    const pluginRoot = findPluginManifest(asPath) === null ? undefined : asPath
    const pluginName =
      pluginRoot === undefined ? undefined : readPluginName(pluginRoot)
    if (pluginName !== undefined) {
      const clash = installed.find(
        p => p.name === pluginName && p.enabled === true,
      )
      if (clash !== undefined) {
        return {
          kind: 'error',
          message:
            `"${pluginName}" is also installed and enabled (${clash.source}).\n` +
            'Both arms would load it, so the control arm is not plugin-free and the delta\n' +
            `would compare this working tree against the installed copy instead.\n` +
            `Run \`${BIN_NAME} plugin disable ${clash.source}\` first, then re-run.`,
        }
      }
    }
    return { kind: 'path', root: evalsRoot, pluginRoot, pluginId: pluginName }
  }

  // Not a path with cases — try it as an installed plugin id/name.
  const resolved = resolvePluginByName([...installed], target)
  if (resolved.kind === 'ambiguous') {
    return {
      kind: 'error',
      message: `"${target}" matches ${resolved.matches.join(', ')}. Use the full plugin@marketplace id.`,
    }
  }
  if (resolved.kind === 'not-found') {
    return {
      kind: 'error',
      message:
        `No eval cases found for "${target}".\n` +
        `Point at a plugin directory containing evals/, or run \`${BIN_NAME} plugin eval init <name>\` to create one.`,
    }
  }
  const installedRoot = resolved.plugin.path
  const cases = resolveEvalsRoot(installedRoot)
  if (cases === null) {
    return {
      kind: 'error',
      message: `Plugin "${target}" has no evals/ directory at ${installedRoot}.`,
    }
  }
  return {
    kind: 'error',
    message:
      `"${target}" resolves to an installed plugin, which is loaded in both arms.\n` +
      `Evaluate its source tree instead: \`${BIN_NAME} plugin eval ${installedRoot}\`` +
      ` (after \`${BIN_NAME} plugin disable ${resolved.plugin.source}\`).`,
  }
}

/** Plugin name from the manifest, used only to spot the install collision. */
function readPluginName(pluginRoot: string): string | undefined {
  const manifest = findPluginManifest(pluginRoot)
  if (manifest === null) return undefined
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      name?: unknown
    }
    return typeof parsed.name === 'string' ? parsed.name : undefined
  } catch {
    return undefined
  }
}

function parseAblation(
  value: string | undefined,
  hasPluginRoot: boolean,
): AblationMode | null {
  if (value === undefined) return hasPluginRoot ? 'with-without' : 'none'
  if (value === 'with-without' || value === 'none') return value
  return null
}

async function pluginEvalHandler(
  target: string | undefined,
  options: EvalOptions,
): Promise<void> {
  if (options.cowork) setUseCoworkPlugins(true)

  const threshold = options.threshold ?? DEFAULT_THRESHOLD
  if (threshold < 0 || threshold > 1) {
    cliError('Error: --threshold must be between 0 and 1')
  }
  const maxCostUsd = options.maxCostUsd ?? DEFAULT_MAX_COST_USD
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    cliError('Error: --max-cost-usd must be a positive number')
  }
  if (
    options.runs !== undefined &&
    (!Number.isInteger(options.runs) || options.runs < 1)
  ) {
    cliError('Error: --runs must be a positive integer')
  }

  const { enabled, disabled } = await loadAllPlugins()
  const resolved = resolveEvalTarget(
    target ?? '.',
    [...enabled, ...disabled],
    getOriginalCwd(),
  )
  if (resolved.kind === 'error') cliError(`Error: ${resolved.message}`)

  const ablation = parseAblation(
    options.ablation,
    resolved.pluginRoot !== undefined,
  )
  if (ablation === null) {
    cliError('Error: --ablation must be "with-without" or "none"')
  }
  if (ablation === 'with-without' && resolved.pluginRoot === undefined) {
    cliError(
      'Error: no plugin manifest found next to these cases, so the two arms would be\n' +
        'identical and the delta would measure nothing. Point at a plugin root, or pass\n' +
        '--ablation none to score the cases without a control arm.',
    )
  }

  const { cases, errors } = discoverCases(resolved.root, {
    allowTools: options.allowTools ?? [],
    caseFilter: options.case,
    tags: options.tag,
    runsOverride: options.runs,
    modelOverride: options.model,
  })

  if (cases.length === 0) {
    for (const e of errors) process.stderr.write(`  ${e.file}: ${e.error}\n`)
    cliError(
      `Error: no eval cases found under ${resolved.root}.\n` +
        `A case is a directory containing case.yaml. Run \`${BIN_NAME} plugin eval init <name>\` to make one.`,
    )
  }

  if (options.dryRun === true) {
    cliOk(renderPlan(planSuite(cases, ablation), { threshold }))
  }

  for (const c of cases) {
    if (c.deniedTools.length > 0) {
      process.stderr.write(
        `note: ${c.name} asked for ${c.deniedTools.join(', ')} — not granted (pass --allow-tools)\n`,
      )
    }
  }

  const controller = new AbortController()
  const onSigint = (): void => {
    if (!controller.signal.aborted) {
      process.stderr.write('\nInterrupted — finishing the current run…\n')
      controller.abort()
    }
  }
  process.on('SIGINT', onSigint)

  try {
    const result = await runSuite({
      root: resolved.root,
      cases,
      loadErrors: errors,
      ablation,
      pluginRoot: resolved.pluginRoot,
      pluginId: resolved.pluginId,
      runner: new SubprocessAgentRunner(),
      model: options.model,
      judgeModel: options.judgeModel ?? DEFAULT_JUDGE_MODEL,
      threshold,
      maxCostUsd,
      maxDurationMs:
        (options.maxDuration ?? DEFAULT_MAX_DURATION_MS / 1000) * 1000,
      runTimeoutMs: options.timeout ?? DEFAULT_RUN_TIMEOUT_MS,
      allowCommands: options.allowAssertCommands === true,
      keepTemp: options.keepTemp === true,
      onLine: line => process.stderr.write(`${line}\n`),
      signal: controller.signal,
    })

    // Bare `--json` owns stdout: anything else there would make the output
    // unparseable for the caller who asked for machine-readable results.
    const jsonToStdout = options.json === true
    if (jsonToStdout) {
      process.stderr.write(`\n${renderTerminalReport(result)}\n`)
    } else {
      process.stdout.write(`\n${renderTerminalReport(result)}\n`)
    }

    if (options.json !== undefined && options.json !== false) {
      const payload = `${jsonStringify(result, null, 2)}\n`
      if (typeof options.json === 'string') {
        writeFileSync(resolve(getOriginalCwd(), options.json), payload)
        process.stderr.write(`Wrote ${options.json}\n`)
      } else {
        process.stdout.write(payload)
      }
    }

    if (options.report !== undefined && options.report !== false) {
      await writeReport(result, options)
    }

    if (
      options.keepTemp !== true &&
      result.cases.some(c => c.with.score < threshold)
    ) {
      process.stderr.write(
        'Re-run with --keep-temp to preserve each run’s workspace and trace.jsonl.\n',
      )
    }

    process.exit(
      exitCodeFor(result, {
        failOnRegression: options.failOnRegression === true,
      }),
    )
  } finally {
    process.off('SIGINT', onSigint)
  }
}

async function writeReport(
  result: Awaited<ReturnType<typeof runSuite>>,
  options: EvalOptions,
): Promise<void> {
  const markdown = renderMarkdownReport(result)
  const target =
    typeof options.report === 'string'
      ? resolve(getOriginalCwd(), options.report)
      : occConfigPath(
          'plugin-eval',
          result.startedAt.replace(/[:.]/g, '-'),
          'report.md',
        )
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, markdown)
    process.stderr.write(`Report: ${target}\n`)
  } catch (error) {
    process.stderr.write(
      `Couldn't write the report: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return
  }

  if (options.publish !== true) return
  // Public entry only — the artifact backend owns its own storage, theming and
  // URL shape, so this command never learns what a report page looks like.
  try {
    const [{ getArtifactStore }, { markdownToHtml }] = await Promise.all([
      import('@open-claude-code/builtin-tools/tools/ArtifactTool/store.js'),
      import('@open-claude-code/builtin-tools/tools/ArtifactTool/markdown.js'),
    ])
    const uploaded = await getArtifactStore().upload({
      html: markdownToHtml(markdown, 'plugin-eval-report'),
      ttlDays: 30,
    })
    process.stderr.write(`Published: ${uploaded.url}\n`)
  } catch (error) {
    process.stderr.write(
      `Couldn't publish the report: ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

function pluginEvalInitHandler(name: string): void {
  const result = scaffoldCase(getOriginalCwd(), name)
  if (!result.ok) cliError(`Error: ${result.error}`)
  cliOk(
    `Created ${result.path}\n\n` +
      `Next: fill in the prompt and assertions, then run\n` +
      `  ${BIN_NAME} plugin eval . --dry-run   # see what it would cost\n` +
      `  ${BIN_NAME} plugin eval .             # run it`,
  )
}

/** Registers `plugin eval` and `plugin eval init`. */
export function registerPluginEvalCommand(
  pluginCmd: CommanderCommand,
  coworkOption: () => Parameters<CommanderCommand['addOption']>[0],
): void {
  const evalCmd = pluginCmd
    .command('eval [target]')
    .description(
      'Measure whether a plugin improves model behaviour, by running each case with and without it',
    )
    .option(
      '--case <glob>',
      'Only run cases whose name matches (supports * and ?)',
    )
    .option('--tag <tag...>', 'Only run cases carrying one of these tags')
    .option(
      '--runs <n>',
      'Repetitions per case, overriding the case file',
      Number,
    )
    .option('--model <model>', 'Model for the agent runs')
    .option(
      '--judge-model <model>',
      `Model for LLM graders (default: ${DEFAULT_JUDGE_MODEL})`,
    )
    .option(
      '--threshold <n>',
      `Minimum passing score, 0-1 (default: ${DEFAULT_THRESHOLD})`,
      Number,
    )
    .option('--ablation <mode>', '"with-without" (default) or "none"')
    .option(
      '--max-cost-usd <usd>',
      `Stop once the suite has spent this much (default: ${DEFAULT_MAX_COST_USD})`,
      Number,
    )
    .option(
      '--max-duration <seconds>',
      `Stop once the suite has run this long (default: ${DEFAULT_MAX_DURATION_MS / 1000})`,
      Number,
    )
    .option(
      '--timeout <ms>',
      `Per-run wall clock (default: ${DEFAULT_RUN_TIMEOUT_MS})`,
      Number,
    )
    .option(
      '--allow-tools <tools...>',
      'Grant tools a case asked for but cannot self-authorize',
    )
    .option(
      '--allow-assert-commands',
      'Permit `command` assertions to run shell from case files',
    )
    .option(
      '--dry-run',
      'List what would run and how many model calls it needs, then stop',
    )
    .option('--keep-temp', "Keep each run's workspace and trace.jsonl")
    .option(
      '--fail-on-regression',
      'Exit non-zero when any case scores worse with the plugin',
    )
    .option(
      '--json [path]',
      'Write the full result as JSON (stdout when no path)',
    )
    .option(
      '--report [path]',
      'Write a markdown report (defaults under the occ config dir)',
    )
    .option('--publish', 'Also publish the report through the artifact backend')
    .addOption(coworkOption())
    .action(async (target: string | undefined, options: EvalOptions) => {
      await pluginEvalHandler(target, options)
    })

  evalCmd
    .command('init <name>')
    .description('Scaffold an eval case under ./evals/<name>/')
    .action((name: string) => {
      pluginEvalInitHandler(name)
    })
}
