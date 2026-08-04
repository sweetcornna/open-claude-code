#!/usr/bin/env bun
/**
 * Keep docs.json's language trees and every page's switcher line in sync with
 * what is actually on disk.
 *
 * Translation lands page by page, so at any moment a language tree is a subset
 * of the canonical one. Two things must follow from that, and neither is
 * something a human should maintain by hand:
 *
 *   1. A language's navigation may only declare pages that exist. Mintlify
 *      publishes a nav entry whose file is missing as a 404 rather than
 *      dropping it, so an un-pruned tree ships broken links.
 *   2. A page's switcher may only link to languages where that page exists,
 *      for the same reason.
 *
 * The canonical page set and group structure come from CANONICAL_LANG, which
 * is the tree that is always complete. Run this after adding or removing any
 * translated page:
 *
 *   bun run sync:docs-i18n
 *   bun run sync:docs-i18n --check   # exit 1 if anything is out of date
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '..')
const CONFIG = join(PROJECT_ROOT, 'docs.json')
const MARKER = '<!-- lang-switcher -->'

/** The tree that is always complete; defines the page set and group order. */
const CANONICAL_LANG = 'zh'

const LANGS = [
  { code: 'en', label: 'English' },
  { code: 'zh', label: '中文' },
  { code: 'ja', label: '日本語' },
] as const

type Group = { group: string; pages?: unknown[]; groups?: unknown[] }

function resolvePage(lang: string, page: string): string | null {
  for (const ext of ['mdx', 'md']) {
    const candidate = join(PROJECT_ROOT, 'docs', lang, `${page}.${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Rewrite a canonical tree for one language, dropping pages that have not
 * been translated yet and any group left empty by that pruning.
 */
function pruneForLanguage(node: unknown, lang: string): unknown | null {
  if (typeof node === 'string') {
    const page = node.replace(`docs/${CANONICAL_LANG}/`, '')
    return resolvePage(lang, page) ? `docs/${lang}/${page}` : null
  }
  if (Array.isArray(node)) {
    const kept = node
      .map(child => pruneForLanguage(child, lang))
      .filter(child => child !== null)
    return kept.length > 0 ? kept : null
  }
  if (node && typeof node === 'object') {
    const source = node as Group & Record<string, unknown>
    const out: Record<string, unknown> = {}
    let hasContent = false
    for (const [key, value] of Object.entries(source)) {
      if (key === 'pages' || key === 'groups') {
        const pruned = pruneForLanguage(value, lang)
        if (pruned === null) continue
        out[key] = pruned
        hasContent = true
      } else {
        out[key] = value
      }
    }
    return hasContent ? out : null
  }
  return null
}

/** The switcher line for one page, linking only to languages that have it. */
function switcherFor(lang: string, page: string): string {
  const parts = LANGS.filter(
    l => l.code === lang || resolvePage(l.code, page) !== null,
  ).map(l =>
    l.code === lang
      ? `**${l.label}**`
      : `[${l.label}](/docs/${l.code}/${page})`,
  )
  return `${MARKER}\n${parts.join(' · ')}`
}

/** Insert or refresh the switcher directly below the frontmatter. */
function applySwitcher(file: string, lang: string, page: string): boolean {
  const original = readFileSync(file, 'utf8')
  const stripped = original.replace(
    new RegExp(`${MARKER}\\n[^\\n]*\\n\\n?`),
    '',
  )
  const block = switcherFor(lang, page)
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(stripped)
  const next = frontmatter
    ? `${stripped.slice(0, frontmatter[0].length)}\n${block}\n\n${stripped
        .slice(frontmatter[0].length)
        .replace(/^\n+/, '')}`
    : `${block}\n\n${stripped.replace(/^\n+/, '')}`

  if (next === original) return false
  writeFileSync(file, next, 'utf8')
  return true
}

function collectPages(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node)
  } else if (Array.isArray(node)) {
    for (const child of node) collectPages(child, out)
  } else if (node && typeof node === 'object') {
    for (const key of ['groups', 'pages']) {
      if (key in (node as Record<string, unknown>)) {
        collectPages((node as Record<string, unknown>)[key], out)
      }
    }
  }
  return out
}

function main(): number {
  const checkOnly = process.argv.includes('--check')
  const raw = readFileSync(CONFIG, 'utf8')
  const config = JSON.parse(raw) as {
    navigation: { languages: Array<{ language: string; groups: unknown }> }
  }

  const canonical = config.navigation.languages.find(
    l => l.language === CANONICAL_LANG,
  )
  if (!canonical) {
    console.error(`[sync-docs-i18n] no '${CANONICAL_LANG}' language tree`)
    return 1
  }

  const canonicalPages = collectPages(canonical.groups).map(p =>
    p.replace(`docs/${CANONICAL_LANG}/`, ''),
  )

  // Default language: the first fully translated one, preferring the declared
  // order. A default with holes would send every reader to a 404 landing tree.
  const complete = LANGS.filter(l =>
    canonicalPages.every(p => resolvePage(l.code, p) !== null),
  ).map(l => l.code)
  const defaultLang = complete[0] ?? CANONICAL_LANG

  const languages = LANGS.map(l => {
    const groups = pruneForLanguage(canonical.groups, l.code) ?? []
    return {
      language: l.code,
      ...(l.code === defaultLang ? { default: true } : {}),
      groups,
    }
  })

  config.navigation = { languages }
  const serialized = `${JSON.stringify(config, null, 2)}\n`

  let switcherChanges = 0
  for (const page of canonicalPages) {
    for (const l of LANGS) {
      const file = resolvePage(l.code, page)
      if (file && applySwitcher(file, l.code, page)) switcherChanges++
    }
  }

  const navChanged = serialized !== raw
  if (checkOnly) {
    if (navChanged || switcherChanges > 0) {
      console.error(
        '[sync-docs-i18n] FAIL out of date — run `bun run sync:docs-i18n`',
      )
      return 1
    }
    console.log('[sync-docs-i18n] up to date')
    return 0
  }

  if (navChanged) writeFileSync(CONFIG, serialized, 'utf8')

  for (const l of LANGS) {
    const have = canonicalPages.filter(
      p => resolvePage(l.code, p) !== null,
    ).length
    const mark = l.code === defaultLang ? ' (default)' : ''
    console.log(
      `[sync-docs-i18n] ${l.code}${mark}  ${have}/${canonicalPages.length} pages`,
    )
  }
  console.log(
    `[sync-docs-i18n] nav ${navChanged ? 'updated' : 'unchanged'}, ` +
      `${switcherChanges} switcher line(s) rewritten`,
  )
  return 0
}

process.exit(main())
