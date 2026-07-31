#!/usr/bin/env bun
/**
 * Circular-dependency ratchet.
 *
 * Counts import cycles reachable from the CLI entrypoint and compares them
 * against a committed budget (scripts/cycle-budget.json). The ratchet is
 * two-sided and both directions are hard failures:
 *
 *   count > budget  the change added cycles — fix them, or justify and raise
 *                   the budget deliberately.
 *   count < budget  the change removed cycles — rerun with --update and commit
 *                   the lower baseline in the same PR, so the improvement is
 *                   locked in and cannot silently regress later.
 *
 * Two counts are tracked, because they fail for different reasons:
 *
 *   runtime  cycles that survive type erasure (detective skipTypeImports).
 *            These are real: they run at import time and can produce
 *            partially-initialised modules / undefined-at-import bugs.
 *   total    every cycle including `import type` edges. Type-only cycles are
 *            harmless at runtime but still make the module graph hard to
 *            reason about and slow to bundle.
 *
 * Usage:
 *   bun run scripts/check-cycles.ts
 *   bun run scripts/check-cycles.ts --update
 *
 * Not part of `precheck` — a full run walks 2300+ modules and takes minutes.
 * CI runs it as its own step.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import madgeImport from 'madge'

const PROJECT_ROOT = join(import.meta.dir, '..')
const BUDGET_FILE = join(PROJECT_ROOT, 'scripts', 'cycle-budget.json')
const ENTRY = 'src/entrypoints/cli.tsx'

/**
 * madge reports module paths relative to the entrypoint's directory, so a
 * cycle in packages/ comes back as `../../packages/@ant/ink/src/index.ts`.
 * Re-anchor those on the project root so printed cycles are copy-pasteable.
 */
const ENTRY_DIR = dirname(join(PROJECT_ROOT, ENTRY))

function displayPath(modulePath: string): string {
  const absolute = isAbsolute(modulePath)
    ? modulePath
    : resolve(ENTRY_DIR, modulePath)
  const fromRoot = relative(PROJECT_ROOT, absolute)
  // Anything that escapes the project root is left as madge reported it.
  return fromRoot.startsWith(`..${sep}`) ? modulePath : fromRoot
}

/** How many example cycles to print when the ratchet trips. */
const SAMPLE_SIZE = 10

type Cycle = string[]

interface MadgeResult {
  circular(): Cycle[]
  obj(): Record<string, string[]>
}

type MadgeFn = (
  entry: string,
  options: Record<string, unknown>,
) => Promise<MadgeResult>

const madge = madgeImport as unknown as MadgeFn

interface Budget {
  runtime: number
  total: number
}

const skipTypeImports = {
  ts: { skipTypeImports: true },
  tsx: { skipTypeImports: true },
}

async function analyze(
  label: string,
  detectiveOptions: Record<string, unknown> | undefined,
): Promise<{ cycles: Cycle[]; moduleCount: number }> {
  const started = Date.now()
  console.log(`[cycles] analyzing ${label}...`)

  const result = await madge(join(PROJECT_ROOT, ENTRY), {
    tsConfig: join(PROJECT_ROOT, 'tsconfig.json'),
    fileExtensions: ['ts', 'tsx'],
    ...(detectiveOptions ? { detectiveOptions } : {}),
  })

  const cycles = result.circular()
  const moduleCount = Object.keys(result.obj()).length
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log(
    `[cycles] ${label}: ${cycles.length} cycles across ${moduleCount} modules (${elapsed}s)`,
  )

  return { cycles, moduleCount }
}

function readBudget(): Budget {
  try {
    const raw = readFileSync(BUDGET_FILE, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Budget).runtime === 'number' &&
      typeof (parsed as Budget).total === 'number'
    ) {
      return parsed as Budget
    }
    throw new Error('budget file must contain numeric "runtime" and "total"')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[cycles] cannot read ${BUDGET_FILE}: ${message}`)
    console.error('[cycles] run with --update to create it.')
    process.exit(1)
  }
}

function writeBudget(budget: Budget): void {
  writeFileSync(BUDGET_FILE, `${JSON.stringify(budget, null, 2)}\n`)
  console.log(
    `[cycles] wrote budget: runtime=${budget.runtime} total=${budget.total}`,
  )
}

function printSample(cycles: Cycle[]): void {
  const sample = cycles.slice(0, SAMPLE_SIZE)
  console.error(
    `[cycles] first ${sample.length} of ${cycles.length} cycles (for debugging):`,
  )
  for (const cycle of sample) {
    const hops = cycle.map(displayPath)
    console.error(`  ${hops.join(' -> ')} -> ${hops[0]}`)
  }
  if (cycles.length > sample.length) {
    console.error(`  ... and ${cycles.length - sample.length} more`)
  }
}

/**
 * Compares one count against its budget. Returns true when the ratchet trips.
 *
 * The comparison is by count, not by identity: madge does not give cycles
 * stable ids, so we cannot diff a set of "known" cycles against a set of new
 * ones. A sample of actual cycle paths is printed instead so the offending
 * import chain can be found by hand.
 */
function check(
  label: string,
  cycles: Cycle[],
  budgeted: number,
  ratchetName: string,
): boolean {
  const actual = cycles.length

  if (actual > budgeted) {
    console.error(
      `\n[cycles] FAIL ${label}: ${actual} cycles, budget is ${budgeted} (+${actual - budgeted}).`,
    )
    console.error(
      '[cycles] This change introduced new import cycles. Break the cycle,',
    )
    console.error(
      `[cycles] or raise "${ratchetName}" in scripts/cycle-budget.json deliberately.`,
    )
    printSample(cycles)
    return true
  }

  if (actual < budgeted) {
    console.error(
      `\n[cycles] FAIL ${label}: ${actual} cycles, budget is ${budgeted} (-${budgeted - actual}).`,
    )
    console.error(
      '[cycles] Cycles were removed — nice. Capture the improvement so it cannot',
    )
    console.error(
      '[cycles] regress: rerun with --update and commit the lower baseline.',
    )
    console.error('[cycles]   bun run check:cycles -- --update')
    return true
  }

  console.log(`[cycles] OK ${label}: ${actual} cycles (at budget).`)
  return false
}

async function main(): Promise<void> {
  const update = process.argv.includes('--update')

  // Read the budget before analyzing: a missing or malformed budget file
  // should fail immediately rather than after several minutes of madge.
  const budget = update ? undefined : readBudget()

  const runtime = await analyze('runtime (type imports skipped)', {
    ...skipTypeImports,
  })
  const total = await analyze('total (type imports included)', undefined)

  if (update || budget === undefined) {
    writeBudget({
      runtime: runtime.cycles.length,
      total: total.cycles.length,
    })
    return
  }

  const runtimeFailed = check(
    'runtime',
    runtime.cycles,
    budget.runtime,
    'runtime',
  )
  const totalFailed = check('total', total.cycles, budget.total, 'total')

  if (runtimeFailed || totalFailed) {
    process.exit(1)
  }

  console.log('\n[cycles] ratchet holds.')
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack : String(error)
  console.error(`[cycles] analysis failed: ${message}`)
  process.exit(1)
})
