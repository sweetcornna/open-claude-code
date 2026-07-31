#!/usr/bin/env bun
/**
 * Prompt/constants purity ratchet.
 *
 * A tool's `constants.ts` and `prompt.ts` should be *leaves*: string data and
 * pure render functions, importing nothing but other tools' `constants.ts`.
 * When they aren't, two things break at once:
 *
 *   startup cost   `FileReadTool/prompt.ts` used to import `isPDFSupported`,
 *                  which chains through the model registry to auth to the API
 *                  client to analytics. Every module that only wanted the
 *                  string 'Read' booted that entire stack.
 *   import cycles  the same edges were the dominant seed of the runtime
 *                  module-graph cycles counted by check-cycles.ts.
 *
 * Two rules, enforced differently:
 *
 *   constants.ts   ALL must be pure. There is no budget — a tool-name constant
 *                  has no business importing anything but another tool name.
 *   prompt.ts      the *count* of impure files is ratcheted against
 *                  scripts/prompt-purity-budget.json, because several prompts
 *                  still read settings inline and converting them is a
 *                  per-tool refactor with prompt-cache risk.
 *
 * The prompt ratchet is two-sided and both directions are hard failures, same
 * contract as check-cycles.ts:
 *
 *   count > budget  the change made a prompt impure — extract the runtime read
 *                   into the tool's prompt() method, or raise the budget
 *                   deliberately.
 *   count < budget  a prompt became pure — rerun with --update and commit the
 *                   lower baseline in the same PR so it cannot silently
 *                   regress later.
 *
 * Purity is decided by import scanning only — no module loading, no graph
 * analysis — so this runs in milliseconds and is safe to put in precheck.
 * `import type` counts: a type-only edge is free at runtime but still shows up
 * in the total cycle count and still tempts the next person to add a value
 * import alongside it.
 *
 * Usage:
 *   bun run scripts/check-prompt-purity.ts
 *   bun run scripts/check-prompt-purity.ts --update
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '..')
const BUDGET_FILE = join(PROJECT_ROOT, 'scripts', 'prompt-purity-budget.json')
const TOOLS_DIR = join(
  PROJECT_ROOT,
  'packages',
  'builtin-tools',
  'src',
  'tools',
)

/** How many offending files to print when the ratchet trips. */
const SAMPLE_SIZE = 10

interface Budget {
  impurePrompts: number
}

/**
 * Matches every module specifier a file pulls in: `import ... from 'x'`,
 * `export ... from 'x'`, bare `import 'x'`, and dynamic `import('x')`.
 */
const SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * The only imports a leaf may have: another tool's constants module, by
 * relative path or by the package's own subpath export.
 */
function isConstantsLeafSpecifier(specifier: string): boolean {
  const withoutExtension = specifier.replace(/\.(js|ts)$/, '')
  if (!withoutExtension.endsWith('/constants')) return false
  return (
    withoutExtension.startsWith('./') ||
    withoutExtension.startsWith('../') ||
    withoutExtension.startsWith('@open-claude-code/builtin-tools/tools/')
  )
}

function impureSpecifiers(filePath: string): string[] {
  const source = readFileSync(filePath, 'utf8')
  const offenders = new Set<string>()
  for (const match of source.matchAll(SPECIFIER_RE)) {
    const specifier = match[1] ?? match[2]
    if (specifier === undefined) continue
    if (isConstantsLeafSpecifier(specifier)) continue
    offenders.add(specifier)
  }
  return [...offenders]
}

interface Offender {
  /** Path relative to the project root, so it is copy-pasteable. */
  file: string
  imports: string[]
}

function scan(fileName: 'constants.ts' | 'prompt.ts'): {
  total: number
  offenders: Offender[]
} {
  const toolDirs = readdirSync(TOOLS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()

  let total = 0
  const offenders: Offender[] = []

  for (const toolDir of toolDirs) {
    const absolute = join(TOOLS_DIR, toolDir, fileName)
    let imports: string[]
    try {
      imports = impureSpecifiers(absolute)
    } catch {
      continue // tool has no such file
    }
    total++
    if (imports.length > 0) {
      offenders.push({
        file: `packages/builtin-tools/src/tools/${toolDir}/${fileName}`,
        imports,
      })
    }
  }

  return { total, offenders }
}

function printOffenders(offenders: Offender[], limit: number): void {
  const sample = offenders.slice(0, limit)
  for (const offender of sample) {
    console.error(`  ${offender.file}`)
    for (const specifier of offender.imports) {
      console.error(`    <- ${specifier}`)
    }
  }
  if (offenders.length > sample.length) {
    console.error(`  ... and ${offenders.length - sample.length} more`)
  }
}

function readBudget(): Budget {
  try {
    const parsed: unknown = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Budget).impurePrompts === 'number'
    ) {
      return parsed as Budget
    }
    throw new Error('budget file must contain a numeric "impurePrompts"')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[prompt-purity] cannot read ${BUDGET_FILE}: ${message}`)
    console.error('[prompt-purity] run with --update to create it.')
    process.exit(1)
  }
}

function writeBudget(budget: Budget): void {
  writeFileSync(BUDGET_FILE, `${JSON.stringify(budget, null, 2)}\n`)
  console.log(
    `[prompt-purity] wrote budget: impurePrompts=${budget.impurePrompts}`,
  )
}

function main(): void {
  const update = process.argv.includes('--update')

  const constants = scan('constants.ts')
  const prompts = scan('prompt.ts')

  console.log(
    `[prompt-purity] scanned ${constants.total} constants.ts and ${prompts.total} prompt.ts files`,
  )

  let failed = false

  if (constants.offenders.length > 0) {
    console.error(
      `\n[prompt-purity] FAIL constants: ${constants.offenders.length} of ${constants.total} are impure.`,
    )
    console.error(
      "[prompt-purity] A constants leaf may only import another tool's constants.",
    )
    console.error(
      '[prompt-purity] Move whatever needs src/ into a sibling module next to it.',
    )
    printOffenders(constants.offenders, constants.offenders.length)
    failed = true
  } else {
    console.log(
      `[prompt-purity] OK constants: all ${constants.total} are pure leaves.`,
    )
  }

  if (update) {
    writeBudget({ impurePrompts: prompts.offenders.length })
    // An impure constants file is never acceptable, so --update must not
    // launder it into a green run.
    if (failed) process.exit(1)
    return
  }

  const budget = readBudget()
  const actual = prompts.offenders.length

  if (actual > budget.impurePrompts) {
    console.error(
      `\n[prompt-purity] FAIL prompts: ${actual} impure, budget is ${budget.impurePrompts} (+${actual - budget.impurePrompts}).`,
    )
    console.error(
      "[prompt-purity] Move the env/settings/feature read into the tool's prompt()",
    )
    console.error(
      '[prompt-purity] method and pass the result to a render function, or raise',
    )
    console.error(
      '[prompt-purity] "impurePrompts" in scripts/prompt-purity-budget.json deliberately.',
    )
    printOffenders(prompts.offenders, SAMPLE_SIZE)
    failed = true
  } else if (actual < budget.impurePrompts) {
    console.error(
      `\n[prompt-purity] FAIL prompts: ${actual} impure, budget is ${budget.impurePrompts} (-${budget.impurePrompts - actual}).`,
    )
    console.error(
      '[prompt-purity] Prompts became pure — nice. Capture the improvement so it',
    )
    console.error(
      '[prompt-purity] cannot regress: rerun with --update and commit the lower baseline.',
    )
    console.error('[prompt-purity]   bun run check:prompt-purity -- --update')
    failed = true
  } else {
    console.log(
      `[prompt-purity] OK prompts: ${actual} impure (at budget), ${prompts.total - actual} pure.`,
    )
  }

  if (failed) process.exit(1)

  console.log('\n[prompt-purity] ratchet holds.')
}

main()
