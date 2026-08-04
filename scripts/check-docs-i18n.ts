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

  // The canonical tree is the largest one: translation lands page by page, so
  // the other trees are subsets of it. Coverage is measured against it so a
  // missing translation reads as a number rather than an invisible hole.
  const canonicalTree = languages.reduce((widest, lang) =>
    collectPages(lang.groups).length > collectPages(widest.groups).length
      ? lang
      : widest,
  )
  const canonical = collectPages(canonicalTree.groups).map(p =>
    p.replace(`docs/${canonicalTree.language}/`, ''),
  )

  // The default language is every reader's landing tree, so it is the one
  // language that may not have holes.
  const defaultCoverage = collectPages(defaults[0]!.groups).length
  if (defaultCoverage < canonical.length) {
    console.error(
      `[docs-i18n] FAIL default language '${defaults[0]!.language}' covers ` +
        `${defaultCoverage}/${canonical.length} pages. The default is the ` +
        `landing tree for every reader and must be complete.`,
    )
    return 1
  }

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
    const pct = canonical.length ? (present / canonical.length) * 100 : 0
    report.push(
      `  ${lang.language}${lang.default ? ' (default)' : '       '}  ` +
        `${String(present).padStart(3)}/${canonical.length} pages  ${pct.toFixed(0).padStart(3)}%` +
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

  // A language may lag behind (translation lands page by page), but it must
  // never declare a page the canonical tree does not have — that would be a
  // page with no source of truth and no way to reach it from the switcher.
  for (const lang of languages) {
    const rel = collectPages(lang.groups).map(p =>
      p.replace(`docs/${lang.language}/`, ''),
    )
    const extra = rel.filter(p => !canonical.includes(p))
    if (extra.length) {
      console.error(
        `[docs-i18n] FAIL ${lang.language} declares pages absent from the ` +
          `canonical tree: ${extra.join(', ')}`,
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
  // Navigation is pruned to existing pages by sync-docs-i18n, so anything
  // declared-but-absent means the two have drifted apart.
  if (missing > 0) {
    console.error(
      `\n[docs-i18n] FAIL ${missing} declared page(s) do not exist on disk. ` +
        `Run \`bun run sync:docs-i18n\`.`,
    )
    return 1
  }
  if (strict) {
    const incomplete = languages.filter(
      lang => collectPages(lang.groups).length < canonical.length,
    )
    if (incomplete.length) {
      console.error(
        `\n[docs-i18n] FAIL --strict: ` +
          incomplete
            .map(
              l =>
                `${l.language} ${collectPages(l.groups).length}/${canonical.length}`,
            )
            .join(', '),
      )
      return 1
    }
  }
  return 0
}

process.exit(main())
