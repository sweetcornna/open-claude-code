#!/usr/bin/env bun
/**
 * Documentation i18n checker.
 *
 * docs.json declares one navigation tree per language. Mintlify will happily
 * publish a tree whose pages do not exist — the entry just 404s — so this
 * verifies that every declared page is actually on disk, and that each page
 * carries the language-switcher line the docs convention requires.
 *
 * Also reports translation coverage, so an in-progress language is visible as
 * a number rather than as a pile of broken links.
 *
 * Usage:
 *   bun run scripts/check-docs-i18n.ts          # report + fail on broken links
 *   bun run scripts/check-docs-i18n.ts --strict # additionally fail on any gap
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '..')
const CONFIG = join(PROJECT_ROOT, 'docs.json')
const SWITCHER_MARKER = '<!-- lang-switcher -->'

type NavNode = string | NavNode[] | { [key: string]: unknown }

type LanguageTree = {
  language: string
  default?: boolean
  groups: NavNode
}

/** Collect every page path declared under a navigation node. */
function collectPages(node: NavNode, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node)
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectPages(child, out)
    return out
  }
  if (node && typeof node === 'object') {
    for (const key of ['groups', 'pages'] as const) {
      if (key in node) collectPages(node[key] as NavNode, out)
    }
  }
  return out
}

/** Resolve a docs.json page path to a file on disk, trying both extensions. */
function resolvePage(page: string): string | null {
  for (const ext of ['mdx', 'md']) {
    const candidate = join(PROJECT_ROOT, `${page}.${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function main(): number {
  const strict = process.argv.includes('--strict')
  const config = JSON.parse(readFileSync(CONFIG, 'utf8')) as {
    navigation: { languages?: LanguageTree[] }
  }
  const languages = config.navigation.languages
  if (!languages?.length) {
    console.error('[docs-i18n] docs.json has no navigation.languages block')
    return 1
  }

  const defaults = languages.filter(l => l.default)
  if (defaults.length !== 1) {
    console.error(
      `[docs-i18n] FAIL exactly one language must be default, found ${defaults.length}`,
    )
    return 1
  }

  // The default language defines the canonical page set; the others are
  // measured against it so a missing translation is a coverage number rather
  // than an invisible hole.
  const canonical = collectPages(defaults[0]!.groups).map(p =>
    p.replace(`docs/${defaults[0]!.language}/`, ''),
  )

  let missing = 0
  let noSwitcher = 0
  const report: string[] = []

  for (const lang of languages) {
    const pages = collectPages(lang.groups)
    const absent: string[] = []
    const unmarked: string[] = []

    for (const page of pages) {
      const file = resolvePage(page)
      if (!file) {
        absent.push(page)
        continue
      }
      if (!readFileSync(file, 'utf8').includes(SWITCHER_MARKER)) {
        unmarked.push(page)
      }
    }

    const present = pages.length - absent.length
    const pct = pages.length ? (present / pages.length) * 100 : 0
    report.push(
      `  ${lang.language}${lang.default ? ' (default)' : '       '}  ` +
        `${String(present).padStart(3)}/${pages.length} pages  ${pct.toFixed(0).padStart(3)}%` +
        (unmarked.length ? `  ${unmarked.length} missing switcher` : ''),
    )
    missing += absent.length
    noSwitcher += unmarked.length

    for (const page of absent.slice(0, 8)) {
      report.push(`      missing: ${page}`)
    }
    if (absent.length > 8) {
      report.push(`      … and ${absent.length - 8} more`)
    }
  }

  // A page set that diverges between languages means the trees describe
  // different documentation, which the switcher links cannot express.
  for (const lang of languages) {
    const rel = collectPages(lang.groups).map(p =>
      p.replace(`docs/${lang.language}/`, ''),
    )
    const extra = rel.filter(p => !canonical.includes(p))
    if (extra.length) {
      console.error(
        `[docs-i18n] FAIL ${lang.language} declares pages absent from the ` +
          `default tree: ${extra.join(', ')}`,
      )
      return 1
    }
  }

  console.log(`[docs-i18n] translation coverage:`)
  console.log(report.join('\n'))

  if (noSwitcher > 0) {
    console.error(
      `\n[docs-i18n] FAIL ${noSwitcher} page(s) lack the ${SWITCHER_MARKER} line.`,
    )
    return 1
  }
  if (missing > 0) {
    const verb = strict ? 'FAIL' : 'PENDING'
    console.error(
      `\n[docs-i18n] ${verb} ${missing} declared page(s) do not exist on disk.`,
    )
    if (strict) return 1
    console.error('[docs-i18n] translation in progress; run --strict to gate.')
  }
  return 0
}

process.exit(main())
