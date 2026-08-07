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

/**
 * Mocking a re-export shim.
 *
 * Several `src/` modules exist only to forward a workspace package —
 * `src/Tool.ts` over `@open-claude-code/tool-runtime/Tool.js`,
 * `src/utils/runtime/errors.ts` over `.../errors.js`, and so on. On Linux (but
 * NOT on macOS) `mock.module('src/Tool.js', …)` replaces the underlying
 * package module too, so the stub reaches every consumer that imports the
 * package path directly.
 *
 * That cost two CI rounds each time it fired:
 *   findToolByName: () => {}   → SearchExtraToolsTool's select: found nothing
 *   AbortError: class …        → AggregateSearchAdapter swallowed the abort
 *
 * Both were invisible locally — the same preload on macOS shows no effect at
 * all — so this rule is static rather than something a test could catch. Mock
 * the package specifier directly, or (usually better) don't mock these at all:
 * shims forward pure, dependency-free code.
 */
// `export … from '@open-claude-code/…'` only — a plain `import` from a package
// is ordinary consumption and carries no penetration hazard. It is re-export
// forwarding, where the shim's exports ARE the package's bindings, that makes
// mocking one replace the other.
const SHIM_MARKER_RE = /\bexport\s[^;]*?from\s+'@open-claude-code\//

function findReExportShims(): Set<string> {
  const shims = new Set<string>()
  for (const file of new Glob('src/**/*.ts').scanSync(PROJECT_ROOT)) {
    const source = readFileSync(join(PROJECT_ROOT, file), 'utf8')
    if (!SHIM_MARKER_RE.test(source)) continue
    // Normalised to the extensionless module path so both `src/Tool.js` and
    // `src/Tool.ts` spellings of the mock specifier match.
    shims.add(file.replaceAll('\\', '/').replace(/\.tsx?$/, ''))
  }
  return shims
}

interface Offender {
  /** Path relative to the project root, so it is copy-pasteable. */
  file: string
  /** Inline `mock.module` surfaces for repo modules. */
  specifiers: string[]
  /** Shared-helper overrides installed at load with no `reset()` anywhere. */
  unscoped: number
  /** `mock.module` specifiers that resolve to a re-export shim. */
  shims: string[]
}

/**
 * A `mock.module` on a re-export shim whose factory is written out by hand.
 *
 * Helper-based factories (`stateMockWith({ … })`) are NOT flagged: those build
 * a complete surface that delegates every non-overridden export to the real
 * module, so replacing the package module with it preserves behaviour. What
 * broke CI twice was a hand-written STUB on a shim — `findToolByName: () => {}`
 * and `AbortError: class extends Error {}` — where the package's real
 * implementation is gone and every later consumer in the shard gets the stub.
 *
 * Flagging the safe form too would put 7 correct call sites in the report, and
 * a ratchet that cries wolf gets muted.
 */
const INLINE_SHIM_MOCK_RE =
  /\bmock\.module\(\s*['"]([^'"]+)['"]\s*,\s*\(\s*\)\s*=>\s*\(\s*\{/g

function scan(): {
  offenders: Offender[]
  total: number
  unscoped: number
  shims: number
} {
  const shimModules = findReExportShims()
  const files = new Set<string>()
  for (const pattern of TEST_GLOBS) {
    for (const file of new Glob(pattern).scanSync(PROJECT_ROOT)) {
      files.add(file)
    }
  }

  const offenders: Offender[] = []
  let total = 0
  let unscopedTotal = 0
  let shimTotal = 0

  for (const file of [...files].sort()) {
    const source = readFileSync(join(PROJECT_ROOT, file), 'utf8')
    const specifiers: string[] = []
    for (const match of source.matchAll(INLINE_MOCK_RE)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      if (!isInternalSpecifier(specifier)) continue
      specifiers.push(specifier)
    }
    const shims: string[] = []
    for (const match of source.matchAll(INLINE_SHIM_MOCK_RE)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      if (shimModules.has(specifier.replace(/\.(ts|tsx|js|jsx)$/, ''))) {
        shims.push(specifier)
      }
    }
    const unscoped = RESET_RE.test(source)
      ? 0
      : [...source.matchAll(UNSCOPED_SETUP_RE)].length
    if (specifiers.length > 0 || unscoped > 0 || shims.length > 0) {
      // Path separators are normalised so the budget file is identical on
      // Windows checkouts.
      offenders.push({
        file: file.replaceAll('\\', '/'),
        specifiers,
        unscoped,
        shims,
      })
      total += specifiers.length
      unscopedTotal += unscoped
      shimTotal += shims.length
    }
  }

  return {
    offenders,
    total,
    unscoped: unscopedTotal,
    shims: shimTotal,
  }
}

/**
 * Per file: `[inline mock.module surfaces, unreset shared-helper overrides,
 * re-export-shim mocks]`. A tuple rather than one number so converting a
 * violation of one kind into another cannot pass silently.
 */
type Budget = Record<string, [number, number, number]>

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
    budget[offender.file] = [
      offender.specifiers.length,
      offender.unscoped,
      offender.shims.length,
    ]
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
  const { offenders, total, unscoped, shims } = scan()

  if (update) {
    writeBudget(offenders)
    console.log(
      `Updated ${BUDGET_FILE.replace(`${PROJECT_ROOT}/`, '')}: ${total} inline surface(s) + ${unscoped} unreset override(s) + ${shims} shim mock(s) across ${offenders.length} file(s).`,
    )
    return
  }

  const budget = readBudget()
  const current = new Map(
    offenders.map(
      o => [o.file, [o.specifiers.length, o.unscoped, o.shims.length]] as const,
    ),
  )

  const addedInline: Offender[] = []
  const addedUnscoped: Offender[] = []
  const addedShims: Offender[] = []
  for (const offender of offenders) {
    const [inlineAllowed, unscopedAllowed, shimAllowed] = budget[
      offender.file
    ] ?? [0, 0, 0]
    if (offender.specifiers.length > inlineAllowed) addedInline.push(offender)
    if (offender.unscoped > unscopedAllowed) addedUnscoped.push(offender)
    if (offender.shims.length > shimAllowed) addedShims.push(offender)
  }

  const removed: string[] = []
  for (const [
    file,
    [inlineAllowed, unscopedAllowed, shimAllowed],
  ] of Object.entries(budget)) {
    const [inlineNow, unscopedNow, shimNow] = current.get(file) ?? [0, 0, 0]
    if (inlineNow < inlineAllowed) {
      removed.push(`${file}  inline ${inlineAllowed} → ${inlineNow}`)
    }
    if (unscopedNow < unscopedAllowed) {
      removed.push(`${file}  unreset ${unscopedAllowed} → ${unscopedNow}`)
    }
    if (shimNow < (shimAllowed ?? 0)) {
      removed.push(`${file}  shim ${shimAllowed} → ${shimNow}`)
    }
  }

  if (addedShims.length > 0) {
    console.error(
      `✗ mock hygiene: ${addedShims.length} file(s) mock a re-export shim.`,
    )
    console.error('')
    console.error(
      '  On Linux — but not macOS — mocking a src/ barrel replaces the workspace',
    )
    console.error(
      '  package module it forwards, so the stub reaches every consumer that',
    )
    console.error(
      '  imports the package path directly. Mock the package specifier instead,',
    )
    console.error(
      '  or drop the mock: shims forward pure, dependency-free code.',
    )
    console.error('')
    for (const offender of addedShims.slice(0, SAMPLE_SIZE)) {
      console.error(`  ${offender.file}`)
      for (const specifier of offender.shims) {
        console.error(`      mock.module('${specifier}', …)`)
      }
    }
    process.exit(1)
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
    `✓ mock hygiene: ${total} inline + ${unscoped} unreset + ${shims} shim mock(s) across ${offenders.length} file(s), none added.`,
  )
}

main()
