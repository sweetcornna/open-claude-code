/**
 * `occ project purge [path]` — delete every trace of one project (or of all
 * projects) from the occ config directory.
 *
 * Ported from the official CLI's `purgeProjectHandler`. The shape is the same:
 * build a plan, print it, confirm, then execute item by item so a single
 * failure reports itself instead of aborting the rest.
 *
 * WHAT IS AND IS NOT PROJECT STATE
 *
 * Deleted: the project's transcript directory under `<configdir>/projects/`
 * (which also carries subagent transcripts and `memory/`), the per-session
 * caches keyed off the session ids found there (`tasks/`, `debug/`,
 * `file-history/`), the project's entry in the global config file (trust,
 * history, project-scoped MCP servers) and its lines in `history.jsonl`.
 *
 * NOT deleted: `shell-snapshots/` — those are per-shell, not per-project, and
 * removing them would break unrelated live sessions. `backups/` is left alone
 * too but warned about, since old global-config snapshots may still mention the
 * project until they rotate out.
 *
 * PATH MATCHING IS EXACT ON PURPOSE
 *
 * Transcript directories are named `sanitizePath(cwd)`, which maps every
 * non-alphanumeric character to `-`. Prefix matching would therefore let
 * `/a/b` claim `/a/b-c`'s directory, so this only ever matches the sanitized
 * name exactly — for the real path and for its realpath, since a symlinked
 * checkout produces two different directory names.
 */

import {
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { occConfigDir } from '../../config/paths.js'
import { sanitizePath } from '../../utils/session/sessionStoragePortable.js'
import { sanitizePathComponent } from '../../utils/task/tasks.js'

export type PurgeItem = {
  /**
   * `dir` / `file` are removed from disk. `config-key` removes
   * `projects[path]` from the global config file. `history-lines` rewrites
   * `history.jsonl` without the matching entries.
   */
  kind: 'dir' | 'file' | 'config-key' | 'history-lines'
  path: string
  reason: string
  /** Only for `history-lines`: the project paths whose entries are dropped. */
  matchPaths?: readonly string[]
}

type PurgePlan = {
  items: PurgeItem[]
  warnings: string[]
}

/** Everything the plan builders need to read, so tests can point at a temp dir. */
type PurgeContext = {
  configDir: string
  /** Keys of `projects` in the global config file. */
  projectKeys: readonly string[]
}

type PurgeOptions = {
  all: boolean
  dryRun: boolean
  yes: boolean
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Trailing separators make two spellings of the same project look different. */
function normalizeProjectKey(path: string): string {
  const forwardSlashed = path.replace(/\\/g, '/')
  return forwardSlashed.replace(/\/+$/, '') || '/'
}

/**
 * The set of spellings that identify this project: the resolved path and, when
 * the path is a symlink (or lives under one), its realpath. occ writes
 * transcripts under whichever one the session started from.
 */
async function projectAliases(projectPath: string): Promise<string[]> {
  const target = resolve(projectPath)
  const aliases = new Set([target])
  try {
    aliases.add(await realpath(target))
  } catch {
    // Not resolvable (deleted checkout) — the literal path is all we have,
    // which is exactly the case where purging is most useful.
  }
  return [...aliases]
}

/** Session ids are the `<uuid>.jsonl` basenames inside a project directory. */
async function sessionIdsIn(projectDir: string): Promise<string[]> {
  try {
    const entries = await readdir(projectDir)
    return entries
      .filter(name => name.endsWith('.jsonl'))
      .map(name => name.slice(0, -'.jsonl'.length))
  } catch {
    return []
  }
}

type HistoryEntry = { project?: unknown }

/**
 * Split `history.jsonl` into the lines that belong to `aliases` and the rest.
 * Unparseable lines are always kept — a corrupt line is not evidence that it
 * belongs to this project, and silently dropping it would lose other projects'
 * history.
 */
async function partitionHistory(
  historyPath: string,
  aliases: readonly string[],
): Promise<{ matched: number; keep: string[] } | null> {
  let raw: string
  try {
    raw = await readFile(historyPath, 'utf8')
  } catch {
    return null
  }
  const normalizedAliases = new Set(aliases.map(normalizeProjectKey))
  const keep: string[] = []
  let matched = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let entry: HistoryEntry | null = null
    try {
      entry = JSON.parse(line) as HistoryEntry
    } catch {
      keep.push(line)
      continue
    }
    if (
      typeof entry?.project === 'string' &&
      normalizedAliases.has(normalizeProjectKey(entry.project))
    ) {
      matched++
      continue
    }
    keep.push(line)
  }
  return { matched, keep }
}

/** Per-session caches that live outside the project directory. */
async function sessionScopedItems(
  configDir: string,
  sessionIds: Iterable<string>,
): Promise<PurgeItem[]> {
  const items: PurgeItem[] = []
  for (const sessionId of sessionIds) {
    const tasksDir = join(configDir, 'tasks', sanitizePathComponent(sessionId))
    if (await pathExists(tasksDir)) {
      items.push({
        kind: 'dir',
        path: tasksDir,
        reason: `tasks for session ${sessionId}`,
      })
    }
    const debugLog = join(configDir, 'debug', `${sessionId}.txt`)
    if (await pathExists(debugLog)) {
      items.push({
        kind: 'file',
        path: debugLog,
        reason: `debug log for session ${sessionId}`,
      })
    }
    const fileHistoryDir = join(configDir, 'file-history', sessionId)
    if (await pathExists(fileHistoryDir)) {
      items.push({
        kind: 'dir',
        path: fileHistoryDir,
        reason: `file edit history for session ${sessionId}`,
      })
    }
  }
  return items
}

async function collectWarnings(configDir: string): Promise<string[]> {
  const warnings: string[] = []
  if (await pathExists(join(configDir, 'shell-snapshots'))) {
    warnings.push(
      'shell-snapshots/ are not project-scoped and will not be touched',
    )
  }
  const backups = join(configDir, 'backups')
  if (await pathExists(backups)) {
    warnings.push(
      `backups/ may still contain this project in old global-config snapshots (${backups}); they rotate out automatically`,
    )
  }
  return warnings
}

export async function buildProjectPurgePlan(
  projectPath: string,
  context: PurgeContext,
): Promise<PurgePlan> {
  const { configDir, projectKeys } = context
  const aliases = await projectAliases(projectPath)
  const items: PurgeItem[] = []

  const projectDirs: string[] = []
  for (const alias of aliases) {
    const dir = join(configDir, 'projects', sanitizePath(alias))
    if (!projectDirs.includes(dir) && (await pathExists(dir))) {
      projectDirs.push(dir)
    }
  }

  const sessionIds = new Set<string>()
  for (const dir of projectDirs) {
    for (const sessionId of await sessionIdsIn(dir)) sessionIds.add(sessionId)
  }
  items.push(...(await sessionScopedItems(configDir, sessionIds)))

  for (const dir of projectDirs) {
    items.push({
      kind: 'dir',
      path: dir,
      reason: 'project transcripts (.jsonl) and memory/',
    })
  }

  const normalizedAliases = new Set(aliases.map(normalizeProjectKey))
  for (const key of projectKeys) {
    if (normalizedAliases.has(normalizeProjectKey(key))) {
      items.push({
        kind: 'config-key',
        path: key,
        reason:
          'project entry in the global config (trust, history, MCP servers)',
      })
    }
  }

  const historyPath = join(configDir, 'history.jsonl')
  const history = await partitionHistory(historyPath, aliases)
  if (history && history.matched > 0) {
    items.push({
      kind: 'history-lines',
      path: historyPath,
      reason: `${history.matched} prompt(s) typed in this project`,
      matchPaths: aliases,
    })
  }

  return { items, warnings: await collectWarnings(configDir) }
}

export async function buildAllProjectsPurgePlan(
  context: PurgeContext,
): Promise<PurgePlan> {
  const { configDir, projectKeys } = context
  const items: PurgeItem[] = []

  const wholeDirs: Array<[string, string]> = [
    ['projects', 'all project transcripts (.jsonl) and memory/'],
    ['tasks', 'all session task lists'],
    ['debug', 'all session debug logs'],
    ['file-history', 'all session file edit history'],
  ]
  for (const [name, reason] of wholeDirs) {
    const dir = join(configDir, name)
    if (await pathExists(dir)) {
      items.push({ kind: 'dir', path: dir, reason })
    }
  }

  const historyPath = join(configDir, 'history.jsonl')
  if (await pathExists(historyPath)) {
    items.push({
      kind: 'file',
      path: historyPath,
      reason: 'prompt history across all projects',
    })
  }

  for (const key of projectKeys) {
    items.push({
      kind: 'config-key',
      path: key,
      reason:
        'project entry in the global config (trust, history, MCP servers)',
    })
  }

  return { items, warnings: await collectWarnings(configDir) }
}

function formatPurgeItem(item: PurgeItem): string {
  switch (item.kind) {
    case 'config-key':
      return `config: projects["${item.path}"]\n           ${item.reason}`
    case 'history-lines':
      return `history: ${item.path}\n           ${item.reason}`
    default:
      return `${item.kind}:    ${item.path}\n           ${item.reason}`
  }
}

export function describePurgePlan(label: string, plan: PurgePlan): string {
  const lines = [`\nPurge plan for ${label}:\n`]
  for (const item of plan.items) lines.push(`  ${formatPurgeItem(item)}`)
  if (plan.warnings.length > 0) {
    lines.push('')
    for (const warning of plan.warnings) lines.push(`  Note: ${warning}`)
  }
  return lines.join('\n')
}

/** Removes a project key from the global config. Injected so tests stay off it. */
type ConfigKeyRemover = (projectPath: string) => Promise<boolean>

/**
 * Executes one item. Returns an error string on failure, `null` on success —
 * the caller collects them so one unwritable path doesn't strand the rest.
 */
export async function applyPurgeItem(
  item: PurgeItem,
  removeConfigKey: ConfigKeyRemover,
): Promise<string | null> {
  try {
    switch (item.kind) {
      case 'config-key': {
        const removed = await removeConfigKey(item.path)
        return removed
          ? null
          : `Failed to remove projects["${item.path}"] from the global config — is your config directory writable?`
      }
      case 'history-lines': {
        const partitioned = await partitionHistory(
          item.path,
          item.matchPaths ?? [],
        )
        if (!partitioned) return null
        const body =
          partitioned.keep.length > 0 ? partitioned.keep.join('\n') + '\n' : ''
        await writeFile(item.path, body, { encoding: 'utf8', mode: 0o600 })
        return null
      }
      default:
        await rm(item.path, { recursive: item.kind === 'dir', force: true })
        return null
    }
  } catch (error) {
    return `${item.path}: ${String(error)}`
  }
}

async function confirm(question: string): Promise<boolean> {
  process.stdout.write(`${question} [y/N] `)
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk as Buffer))
    if (Buffer.concat(chunks).includes('\n')) break
  }
  const answer = Buffer.concat(chunks).toString('utf8').trim().toLowerCase()
  return answer === 'y' || answer === 'yes'
}

/**
 * Returns the process exit code. Prints its own output, like `runMigrate`.
 */
export async function runProjectPurge(
  projectPath: string | undefined,
  options: PurgeOptions,
): Promise<number> {
  if (options.all && projectPath) {
    console.error('Cannot specify both a path and --all.')
    return 1
  }

  const configDir = occConfigDir()
  const { getGlobalConfig, saveGlobalConfig } = await import(
    '../../utils/config/config.js'
  )
  const projectKeys = Object.keys(getGlobalConfig().projects ?? {})
  const context: PurgeContext = { configDir, projectKeys }

  const label = options.all ? 'all projects' : resolve(projectPath ?? '.')
  const plan = options.all
    ? await buildAllProjectsPurgePlan(context)
    : await buildProjectPurgePlan(label, context)

  if (plan.items.length === 0) {
    console.error(
      options.all
        ? `No project state found under ${configDir}.`
        : `No project state found for ${label} under ${configDir}.`,
    )
    return 1
  }

  console.log(describePurgePlan(label, plan))

  if (options.dryRun) {
    console.log(`\nDry run: ${plan.items.length} item(s) would be deleted.`)
    return 0
  }

  if (!options.yes) {
    const scope = options.all
      ? `Delete ${plan.items.length} item(s) for ALL projects?`
      : `Delete ${plan.items.length} item(s) for ${label}?`
    if (!(await confirm(`\n${scope} This cannot be undone.`))) {
      console.error('Aborted.')
      return 1
    }
  }

  const removeConfigKey: ConfigKeyRemover = async key => {
    saveGlobalConfig(current => {
      if (!current.projects || !(key in current.projects)) return current
      const rest = { ...current.projects }
      delete rest[key]
      return { ...current, projects: rest }
    })
    return !(getGlobalConfig().projects ?? {})[key]
  }

  const failures: string[] = []
  for (const item of plan.items) {
    const failure = await applyPurgeItem(item, removeConfigKey)
    if (failure) failures.push(failure)
  }

  if (failures.length > 0) {
    console.error(
      `${failures.length} item(s) failed:\n  ${failures.join('\n  ')}`,
    )
    return 1
  }

  console.log(`Purged ${plan.items.length} item(s) for ${label}.`)
  return 0
}
