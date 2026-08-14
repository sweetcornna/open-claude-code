/**
 * Finding and loading eval cases.
 *
 * Layout, in full:
 *
 *   <plugin-root>/
 *     .claude-plugin/plugin.json
 *     evals/
 *       adds-changelog-entry/
 *         case.yaml            <- the whole declaration
 *         files/               <- optional seed copied into each workspace
 *
 * One declaration file per case, no sidecar grader directory. Upstream splits
 * graders into `graders/<name>.md` with frontmatter, which buys per-grader
 * prose at the cost of the author holding a directory convention in their head
 * and of every grader defaulting to the expensive kind. A single `case.yaml`
 * keeps the prompt and the assertions that judge it in one screen.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, join, resolve } from 'path'
import { parseYaml } from '../../text/yaml.js'
import { EvalCaseSchema, partitionRequestedTools } from './caseSchema.js'
import type { LoadedCase } from './types.js'

/** The one file that makes a directory a case. */
export const CASE_FILE_NAME = 'case.yaml'

/** Conventional directory holding a plugin's cases. */
export const EVALS_DIR_NAME = 'evals'

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.occ',
  '.claude',
  'results',
])

const MAX_DEPTH = 8

/** Case names are used as path segments and report keys. */
export const CASE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/

export type CaseLoadError = { file: string; error: string }

/** Does this directory look like a plugin root? */
export function findPluginManifest(root: string): string | null {
  const modern = join(root, '.claude-plugin', 'plugin.json')
  if (existsSync(modern)) return modern
  const legacy = join(root, 'plugin.json')
  if (existsSync(legacy)) return legacy
  return null
}

/**
 * Where cases live for a given target.
 *
 * Accepts a plugin root (uses its `evals/`), an `evals` directory itself, or a
 * single case directory — so `occ plugin eval ./evals/my-case` works while
 * iterating on one case.
 */
export function resolveEvalsRoot(target: string): string | null {
  if (!existsSync(target) || !statSync(target).isDirectory()) return null
  if (existsSync(join(target, CASE_FILE_NAME))) return target
  const nested = join(target, EVALS_DIR_NAME)
  if (existsSync(nested) && statSync(nested).isDirectory()) return nested
  if (basename(target) === EVALS_DIR_NAME) return target
  return null
}

/** Recursively collect directories containing a `case.yaml`. */
export function findCaseDirs(root: string, depth = 0): string[] {
  if (depth > MAX_DEPTH) return []
  if (existsSync(join(root, CASE_FILE_NAME))) return [root]
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries.sort()) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
    const child = join(root, entry)
    try {
      if (!statSync(child).isDirectory()) continue
    } catch {
      continue
    }
    found.push(...findCaseDirs(child, depth + 1))
  }
  return found
}

/** `*` and `?` only — a filter, not a general glob engine. */
export function caseNameMatches(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const regex = `^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`
  try {
    return new RegExp(regex).test(name)
  } catch {
    return false
  }
}

export type LoadOptions = {
  /** Tools the operator granted with `--allow-tools`. */
  allowTools: readonly string[]
  /** `--case` filter. */
  caseFilter?: string
  /** `--tag` filters, OR-matched. */
  tags?: readonly string[]
  /** `--runs` override; wins over the case's own `runs`. */
  runsOverride?: number
  /** `--model` override; wins over the case's own `model`. */
  modelOverride?: string
}

/** Parse one `case.yaml` into a {@link LoadedCase}. */
export function loadCase(
  caseDir: string,
  options: LoadOptions,
): { ok: true; value: LoadedCase } | { ok: false; error: string } {
  const file = join(caseDir, CASE_FILE_NAME)
  let raw: unknown
  try {
    raw = parseYaml(readFileSync(file, 'utf8'))
  } catch (error) {
    return {
      ok: false,
      error: `could not parse YAML: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const parsed = EvalCaseSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.join('.') || '(root)'
    return { ok: false, error: `${where}: ${issue?.message ?? 'invalid case'}` }
  }
  const spec = parsed.data

  const name = spec.name ?? basename(caseDir)
  if (!CASE_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: `case name "${name}" is invalid — use letters, digits, '.', '_', '-'`,
    }
  }

  let prompt: string
  if (spec.prompt !== undefined) {
    prompt = spec.prompt
  } else {
    // `prompt_file` is resolved inside the case directory for the same reason
    // assertion paths are confined to the workspace: a case file is data.
    const promptPath = resolve(caseDir, spec.prompt_file!)
    if (!promptPath.startsWith(resolve(caseDir))) {
      return {
        ok: false,
        error: `prompt_file "${spec.prompt_file}" escapes the case directory`,
      }
    }
    if (!existsSync(promptPath)) {
      return {
        ok: false,
        error: `prompt_file "${spec.prompt_file}" does not exist`,
      }
    }
    prompt = readFileSync(promptPath, 'utf8')
  }
  if (prompt.trim() === '') {
    return { ok: false, error: 'prompt is empty' }
  }

  const { allowed, denied } = partitionRequestedTools(
    spec.allowed_tools,
    options.allowTools,
  )

  return {
    ok: true,
    value: {
      name,
      dir: caseDir,
      file,
      spec: {
        ...spec,
        runs: options.runsOverride ?? spec.runs,
        model: options.modelOverride ?? spec.model,
      },
      prompt,
      allowedTools: allowed,
      deniedTools: denied,
    },
  }
}

/** Load every case under `root`, applying `--case` and `--tag` filters. */
export function discoverCases(
  root: string,
  options: LoadOptions,
): { cases: LoadedCase[]; errors: CaseLoadError[] } {
  const cases: LoadedCase[] = []
  const errors: CaseLoadError[] = []
  for (const dir of findCaseDirs(root)) {
    const result = loadCase(dir, options)
    if (!result.ok) {
      errors.push({ file: join(dir, CASE_FILE_NAME), error: result.error })
      continue
    }
    const loaded = result.value
    if (
      options.caseFilter !== undefined &&
      !caseNameMatches(loaded.name, options.caseFilter)
    ) {
      continue
    }
    if (options.tags !== undefined && options.tags.length > 0) {
      const wanted = new Set(options.tags)
      if (!loaded.spec.tags.some(t => wanted.has(t))) continue
    }
    cases.push(loaded)
  }
  cases.sort((a, b) => a.name.localeCompare(b.name))
  return { cases, errors }
}
