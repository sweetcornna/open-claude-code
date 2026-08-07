#!/usr/bin/env bun
/**
 * Test-mock hygiene ratchet.
 *
 * Bun's `mock.module` is process-global and last-write-wins, and Bun runs every
 * test file of a shard in ONE process. A file that installs its own inline
 * surface therefore does not mock "for itself" — it mocks for every file loaded
 * after it, for the rest of the run. Two things go wrong:
 *
 *   missing exports  a hand-written surface only lists what its own suite
 *                    calls. Every other export becomes `undefined` for later
 *                    files ("x is not a function", "Export not found").
 *   stuck overrides  even a COMPLETE surface poisons later files if the
 *                    override itself is a lie. `src/utils/sandbox/__tests__/`
 *                    spread the real module and pinned
 *                    `getSettingsFilePathForSource: () => undefined`; that made
 *                    `settings/__tests__/changeDetector.test.ts` watch the
 *                    wrong directories. `MagicDocs/__tests__/prompts.test.ts`
 *                    left behind a hand-rolled fs adapter with no *Sync
 *                    methods, so `updateSettingsForSource` threw and
 *                    `pluginOperations.builtinSecurity.test.ts` got
 *                    success:false.
 *
 * Both only ever failed on Linux: Bun's test-file order comes from the
 * filesystem, is neither alphabetical nor argument order, and differs from
 * macOS. CI was red on all 55 runs between v2.11.0 and v2.30.0; no local run
 * ever reproduced either one.
 *
 * The fix for both is the same and already exists: `tests/mocks/*` builds a
 * complete surface whose exports delegate to the real module, with overrides
 * scoped to one suite (`setup()` at load, `set()` in `beforeAll`, `reset()` in
 * `afterAll`). See tests/mocks/sharedModuleMock.ts.
 *
 * So the rule enforced here is narrow and syntactic:
 *
 *   a `mock.module()` whose specifier resolves INSIDE this repo must take its
 *   factory from a helper (an identifier or a call — `logMock`,
 *   `authMockWith({...})`, `setupSettingsMock()`), never an inline
 *   `() => ({ ... })` literal.
 *
 * Third-party and builtin specifiers (`bun:bundle`, `axios`, `node:*`) are
 * exempt: they have no repo module to delegate to, and a stale surface there
 * cannot desynchronise from source that lives in this tree.
 *
 * Inline factories that predate the rule are ratcheted per file against
 * scripts/mock-hygiene-budget.json rather than fixed in one sweep — converting
 * ~180 call sites at once would be a far riskier diff than the bug it prevents.
 * The ratchet is two-sided, same contract as check-cycles.ts and
 * check-prompt-purity.ts:
 *
 *   count > budget  new inline surface — route it through tests/mocks/.
 *   count < budget  one was converted — rerun with --update and commit the
 *                   lower baseline so it cannot silently come back.
 *
 * Pure text scanning, no module loading, so it runs in milliseconds and is safe
 * inside precheck.
 *
 * Usage:
 *   bun run scripts/check-mock-hygiene.ts
 *   bun run scripts/check-mock-hygiene.ts --update
 */

import { Glob } from 'bun'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '..')
const BUDGET_FILE = join(PROJECT_ROOT, 'scripts', 'mock-hygiene-budget.json')

/** How many offending files to print when the ratchet trips. */
const SAMPLE_SIZE = 12

const TEST_GLOBS = [
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'src/**/*.runner.ts',
  'packages/**/*.test.ts',
  'packages/**/*.test.tsx',
  'tests/**/*.test.ts',
]

/**
 * `mock.module('<spec>', () => ({` — the inline object-literal factory. A
 * helper-based call (`mock.module('x', logMock)`) does not match, which is the
 * whole point.
 */
const INLINE_MOCK_RE =
  /\bmock\.module\(\s*['"]([^'"]+)['"]\s*,\s*\(\s*\)\s*=>\s*\(\s*\{/g

/**
 * Specifiers that resolve to a module in this repository. Everything else
 * (npm packages, `node:*`, `bun:*`) is out of scope.
 */
function isInternalSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith('src/') ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('tests/') ||
    specifier.startsWith('@open-claude-code/')
  )
}

/**
 * `setupSettingsMock({ … })` / `makeSharedModuleMock(…).setup({ … })` — the
 * shared helper used correctly in shape, but with the overrides installed at
 * module load. A file doing this and never calling `reset()` leaves its
 * overrides in place for every later file in the shard, which is the same leak
 * as an inline surface even though the surface itself is complete. `setup()`
 * with no argument is fine: it installs the all-real delegating surface.
 */
const UNSCOPED_SETUP_RE = /(?:setup[A-Za-z]*Mock\(\s*\{|\.setup\(\s*\{)/g
const RESET_RE = /\.reset\(\s*\)/

// Known limitation: a single `.reset()` anywhere in the file clears the whole
// file's unscoped count, so a file that resets one of three mocks scores zero.
// Deliberately biased toward under-reporting — this is text matching, not
// scope analysis, and a ratchet that cries wolf gets muted. The inline-surface
// rule above is the exact one; this is the cheap net under it.

interface Offender {
  /** Path relative to the project root, so it is copy-pasteable. */
  file: string
  /** Inline `mock.module` surfaces for repo modules. */
  specifiers: string[]
  /** Shared-helper overrides installed at load with no `reset()` anywhere. */
  unscoped: number
}

function scan(): { offenders: Offender[]; total: number; unscoped: number } {
  const files = new Set<string>()
  for (const pattern of TEST_GLOBS) {
    for (const file of new Glob(pattern).scanSync(PROJECT_ROOT)) {
      files.add(file)
    }
  }

  const offenders: Offender[] = []
  let total = 0
  let unscopedTotal = 0

  for (const file of [...files].sort()) {
    const source = readFileSync(join(PROJECT_ROOT, file), 'utf8')
    const specifiers: string[] = []
    for (const match of source.matchAll(INLINE_MOCK_RE)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      if (!isInternalSpecifier(specifier)) continue
      specifiers.push(specifier)
    }
    const unscoped = RESET_RE.test(source)
      ? 0
      : [...source.matchAll(UNSCOPED_SETUP_RE)].length
    if (specifiers.length > 0 || unscoped > 0) {
      // Path separators are normalised so the budget file is identical on
      // Windows checkouts.
      offenders.push({ file: file.replaceAll('\\', '/'), specifiers, unscoped })
      total += specifiers.length
      unscopedTotal += unscoped
    }
  }

  return { offenders, total, unscoped: unscopedTotal }
}

/**
 * Per file: `[inline mock.module surfaces, unreset shared-helper overrides]`.
 * A pair rather than one number so converting an inline surface into a
 * still-unreset helper call cannot pass silently.
 */
type Budget = Record<string, [number, number]>

function readBudget(): Budget {
  try {
    return JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as Budget
  } catch {
    return {}
  }
}

function writeBudget(offenders: Offender[]): void {
  const budget: Budget = {}
  for (const offender of offenders) {
    budget[offender.file] = [offender.specifiers.length, offender.unscoped]
  }
  writeFileSync(BUDGET_FILE, `${JSON.stringify(budget, null, 2)}\n`)
}

function printHint(): void {
  console.error('')
  console.error('  Route the mock through tests/mocks/ instead:')
  console.error('')
  console.error(
    "    import { setupSettingsMock } from 'tests/mocks/settings.js'",
  )
  console.error(
    '    const settingsMock = setupSettingsMock()   // all-real surface',
  )
  console.error(
    '    beforeAll(() => settingsMock.set({ getInitialSettings: () => ({}) }))',
  )
  console.error('    afterAll(() => settingsMock.reset())')
  console.error('')
  console.error('  For a module with no wrapper yet, wrap it in place:')
  console.error('')
  console.error("    import * as real from 'src/utils/process/platform.js'")
  console.error(
    "    import { makeSharedModuleMock } from 'tests/mocks/sharedModuleMock.js'",
  )
  console.error(
    "    const m = makeSharedModuleMock('src/utils/process/platform.js', real).setup()",
  )
  console.error('')
  console.error('  See scripts/check-mock-hygiene.ts for why this matters.')
}

function main(): void {
  const update = process.argv.includes('--update')
  const { offenders, total, unscoped } = scan()

  if (update) {
    writeBudget(offenders)
    console.log(
      `Updated ${BUDGET_FILE.replace(`${PROJECT_ROOT}/`, '')}: ${total} inline surface(s) + ${unscoped} unreset override(s) across ${offenders.length} file(s).`,
    )
    return
  }

  const budget = readBudget()
  const current = new Map(
    offenders.map(o => [o.file, [o.specifiers.length, o.unscoped] as const]),
  )

  const addedInline: Offender[] = []
  const addedUnscoped: Offender[] = []
  for (const offender of offenders) {
    const [inlineAllowed, unscopedAllowed] = budget[offender.file] ?? [0, 0]
    if (offender.specifiers.length > inlineAllowed) addedInline.push(offender)
    if (offender.unscoped > unscopedAllowed) addedUnscoped.push(offender)
  }

  const removed: string[] = []
  for (const [file, [inlineAllowed, unscopedAllowed]] of Object.entries(
    budget,
  )) {
    const [inlineNow, unscopedNow] = current.get(file) ?? [0, 0]
    if (inlineNow < inlineAllowed) {
      removed.push(`${file}  inline ${inlineAllowed} → ${inlineNow}`)
    }
    if (unscopedNow < unscopedAllowed) {
      removed.push(`${file}  unreset ${unscopedAllowed} → ${unscopedNow}`)
    }
  }

  if (addedInline.length > 0) {
    console.error(
      `✗ mock hygiene: ${addedInline.length} file(s) added an inline mock.module surface for a repo module.`,
    )
    console.error('')
    console.error(
      '  Bun runs a whole shard in one process and mock.module is global, so this',
    )
    console.error(
      '  surface is installed for every test file loaded afterwards — not just yours.',
    )
    console.error('')
    for (const offender of addedInline.slice(0, SAMPLE_SIZE)) {
      console.error(`  ${offender.file}`)
      for (const specifier of offender.specifiers) {
        console.error(`      mock.module('${specifier}', () => ({ … }))`)
      }
    }
    if (addedInline.length > SAMPLE_SIZE) {
      console.error(`  … and ${addedInline.length - SAMPLE_SIZE} more`)
    }
    printHint()
    process.exit(1)
  }

  if (addedUnscoped.length > 0) {
    console.error(
      `✗ mock hygiene: ${addedUnscoped.length} file(s) install shared-mock overrides at load and never reset them.`,
    )
    console.error('')
    console.error(
      '  A complete surface still leaks if the OVERRIDE outlives the suite — that is',
    )
    console.error(
      '  exactly how changeDetector.test.ts broke. Move the overrides into beforeAll',
    )
    console.error('  and add `afterAll(() => mock.reset())`.')
    console.error('')
    for (const offender of addedUnscoped.slice(0, SAMPLE_SIZE)) {
      console.error(
        `  ${offender.file}  (${offender.unscoped} override site(s), no reset())`,
      )
    }
    if (addedUnscoped.length > SAMPLE_SIZE) {
      console.error(`  … and ${addedUnscoped.length - SAMPLE_SIZE} more`)
    }
    printHint()
    process.exit(1)
  }

  if (removed.length > 0) {
    console.error(
      `✗ mock hygiene: ${removed.length} entr(ies) dropped below the recorded baseline.`,
    )
    console.error('')
    console.error(
      '  Good change — commit the lower baseline in the same PR so it cannot regress:',
    )
    console.error('')
    console.error('    bun run scripts/check-mock-hygiene.ts --update')
    console.error('')
    for (const entry of removed.slice(0, SAMPLE_SIZE)) {
      console.error(`  ${entry}`)
    }
    if (removed.length > SAMPLE_SIZE) {
      console.error(`  … and ${removed.length - SAMPLE_SIZE} more`)
    }
    process.exit(1)
  }

  console.log(
    `✓ mock hygiene: ${total} legacy inline surface(s) + ${unscoped} unreset override(s) across ${offenders.length} file(s), none added.`,
  )
}

main()
