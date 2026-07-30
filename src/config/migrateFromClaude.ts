/**
 * One-time migration of a user's setup from official Claude Code's `~/.claude`
 * into occ's `~/.occ`.
 *
 * DESIGN RULES — all four are load-bearing:
 *
 * 1. `~/.claude` is READ-ONLY. occ never writes to, moves, or deletes anything
 *    under it. The user may still be using the official CLI, and a migration
 *    that mutates the source is not a migration, it is a takeover.
 *
 * 2. Credentials are NEVER copied. `~/.claude/.credentials.json` and the macOS
 *    keychain entry are shared with the official CLI; copying them would carry
 *    over the exact coupling this whole effort removes. Users run /login once.
 *
 * 3. Session history is NEVER copied. `projects/`, `history.jsonl` and the
 *    caches are large, machine-specific, and reference absolute paths; copying
 *    them buys nothing and can be tens of GB.
 *
 * 4. It is idempotent and never clobbers. A `.migrated` marker short-circuits
 *    subsequent runs, and any destination path that already exists is skipped
 *    rather than overwritten.
 *
 * What DOES come across is the user's authored configuration: settings, the
 * extensions they wrote or installed, and their MCP server definitions.
 */

import { join } from 'path'
import {
  legacyClaudeConfigDir,
  occConfigDir,
  occGlobalConfigFile,
} from './paths.js'

/** Marker written into the occ config dir once a migration has run. */
export const MIGRATION_MARKER = '.migrated'

/**
 * Directories copied wholesale. These are things the user authored or
 * deliberately installed.
 */
export const MIGRATED_DIRECTORIES = [
  'skills',
  'agents',
  'commands',
  'output-styles',
  'workflows',
  'templates',
  'plugins',
  'rules',
] as const

/** Individual files copied. */
export const MIGRATED_FILES = [
  'settings.json',
  // User-level memory. Still named CLAUDE.md: the memory filename is an
  // ecosystem convention and is deliberately not renamed.
  'CLAUDE.md',
] as const

/**
 * Never copied, even if a future edit adds them to the lists above. Asserted in
 * tests so this stays true.
 */
export const NEVER_MIGRATED = [
  '.credentials.json',
  'projects',
  'history.jsonl',
  'ide',
  'statsig',
  'logs',
  'shell-snapshots',
  'file-history',
  'todos',
] as const

export type MigrationItem = {
  name: string
  kind: 'dir' | 'file'
  from: string
  to: string
}

export type MigrationPlan = {
  sourceDir: string
  targetDir: string
  /** False when there is nothing to migrate from. */
  sourceExists: boolean
  /** True once a migration has already run (marker present). */
  alreadyMigrated: boolean
  /** Items that exist in the source and are absent from the destination. */
  items: MigrationItem[]
  /** Number of MCP servers found in the legacy global config file. */
  mcpServerCount: number
}

export type FsProbe = {
  exists: (path: string) => boolean
  isDirectory: (path: string) => boolean
  readFile: (path: string) => string
}

/**
 * Whether the migration should even be considered.
 *
 * `OCC_SKIP_MIGRATION=1` opts out permanently for scripted/CI environments,
 * where an interactive prompt would hang.
 */
export function isMigrationSuppressed(): boolean {
  const value = process.env.OCC_SKIP_MIGRATION
  return value === '1' || value === 'true'
}

/**
 * Build a migration plan. Pure apart from the filesystem probes passed in,
 * which keeps it testable without touching a real home directory.
 */
export function planMigrationFromClaude(
  fs: FsProbe,
  options: { force?: boolean } = {},
): MigrationPlan {
  const sourceDir = legacyClaudeConfigDir()
  const targetDir = occConfigDir()

  const plan: MigrationPlan = {
    sourceDir,
    targetDir,
    sourceExists: fs.exists(sourceDir) && fs.isDirectory(sourceDir),
    alreadyMigrated: fs.exists(join(targetDir, MIGRATION_MARKER)),
    items: [],
    mcpServerCount: 0,
  }

  // `force` ignores the marker but NOT the per-item no-clobber checks below,
  // so a forced run fills in what is missing rather than overwriting what the
  // user already has on the occ side.
  if (!plan.sourceExists || (plan.alreadyMigrated && !options.force)) {
    return plan
  }

  // Guard against a same-directory migration: if the user pointed
  // OCC_CONFIG_DIR at ~/.claude there is nothing to do and copying a tree onto
  // itself would be destructive.
  if (sourceDir === targetDir) {
    plan.sourceExists = false
    return plan
  }

  for (const name of MIGRATED_DIRECTORIES) {
    const from = join(sourceDir, name)
    const to = join(targetDir, name)
    if (fs.exists(from) && fs.isDirectory(from) && !fs.exists(to)) {
      plan.items.push({ name, kind: 'dir', from, to })
    }
  }

  for (const name of MIGRATED_FILES) {
    const from = join(sourceDir, name)
    const to = join(targetDir, name)
    if (fs.exists(from) && !fs.isDirectory(from) && !fs.exists(to)) {
      plan.items.push({ name, kind: 'file', from, to })
    }
  }

  plan.mcpServerCount = countLegacyMcpServers(fs)
  return plan
}

/**
 * MCP servers live in the legacy global config file (`~/.claude.json`), not in
 * the config directory, so they need reading separately.
 */
export function readLegacyMcpServers(
  fs: FsProbe,
): Record<string, unknown> | null {
  // The legacy global file sits next to the legacy config dir, mirroring the
  // shape occGlobalConfigFile() produces for occ itself.
  const legacyGlobal = join(legacyClaudeConfigDir(), '..', '.claude.json')
  if (!fs.exists(legacyGlobal)) return null
  try {
    const parsed = JSON.parse(fs.readFile(legacyGlobal)) as Record<
      string,
      unknown
    >
    const servers = parsed.mcpServers
    if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
      return servers as Record<string, unknown>
    }
  } catch {
    // Malformed legacy config is not fatal — the rest of the migration is
    // still worth running.
  }
  return null
}

function countLegacyMcpServers(fs: FsProbe): number {
  const servers = readLegacyMcpServers(fs)
  return servers ? Object.keys(servers).length : 0
}

export type MigrationResult = {
  copied: string[]
  mcpServersImported: number
  errors: string[]
}

/**
 * Perform the copy described by `plan`.
 *
 * Deliberately not transactional: a partial migration leaves the user with
 * some of their config rather than none, and every individual copy is
 * skip-if-exists, so re-running finishes the job. Failures are collected
 * rather than thrown so one unreadable directory cannot abort the rest.
 *
 * The `.migrated` marker is written even on partial success — re-running is
 * available via `occ migrate --force`, and we must not re-prompt on every
 * startup because one plugin directory had bad permissions.
 */
export async function executeMigration(
  plan: MigrationPlan,
): Promise<MigrationResult> {
  const { cp, mkdir, readFile, writeFile } = await import('node:fs/promises')
  const result: MigrationResult = {
    copied: [],
    mcpServersImported: 0,
    errors: [],
  }

  await mkdir(plan.targetDir, { recursive: true })

  for (const item of plan.items) {
    try {
      // force:false so an entry created between planning and now is not
      // overwritten — the no-clobber rule holds even under a race.
      await cp(item.from, item.to, {
        recursive: item.kind === 'dir',
        force: false,
        errorOnExist: false,
      })
      result.copied.push(item.name)
    } catch (error) {
      result.errors.push(`${item.name}: ${(error as Error).message}`)
    }
  }

  // MCP servers live in the legacy global config file, so they are merged
  // rather than copied. Existing occ entries win: this is an import, not an
  // overwrite.
  try {
    const legacyGlobal = join(legacyClaudeConfigDir(), '..', '.claude.json')
    const raw = await readFile(legacyGlobal, 'utf8').catch(() => null)
    if (raw) {
      const legacy = JSON.parse(raw) as Record<string, unknown>
      const servers = legacy.mcpServers
      if (servers && typeof servers === 'object' && !Array.isArray(servers)) {
        const targetPath = occGlobalConfigFile()
        const existingRaw = await readFile(targetPath, 'utf8').catch(() => null)
        const existing = existingRaw
          ? (JSON.parse(existingRaw) as Record<string, unknown>)
          : {}
        const existingServers =
          existing.mcpServers && typeof existing.mcpServers === 'object'
            ? (existing.mcpServers as Record<string, unknown>)
            : {}
        const merged = { ...(servers as Record<string, unknown>) }
        Object.assign(merged, existingServers)
        existing.mcpServers = merged
        await writeFile(targetPath, `${JSON.stringify(existing, null, 2)}\n`)
        result.mcpServersImported = Object.keys(
          servers as Record<string, unknown>,
        ).length
      }
    }
  } catch (error) {
    result.errors.push(`mcpServers: ${(error as Error).message}`)
  }

  await writeFile(
    join(plan.targetDir, MIGRATION_MARKER),
    `migrated from ${plan.sourceDir}\n`,
  )

  return result
}

/** Human-readable summary shown before asking the user to confirm. */
export function describeMigrationPlan(plan: MigrationPlan): string {
  if (!plan.sourceExists) {
    return `No existing Claude Code configuration found at ${plan.sourceDir}.`
  }
  if (plan.alreadyMigrated) {
    return `Already migrated (${join(plan.targetDir, MIGRATION_MARKER)} exists).`
  }
  if (plan.items.length === 0 && plan.mcpServerCount === 0) {
    return `Nothing to migrate from ${plan.sourceDir}.`
  }

  const lines = [
    `Found an existing Claude Code setup at ${plan.sourceDir}.`,
    `open-claude-code keeps its own configuration in ${plan.targetDir}, so the two do not interfere.`,
    '',
    'Would copy:',
  ]
  for (const item of plan.items) {
    lines.push(`  ${item.name}${item.kind === 'dir' ? '/' : ''}`)
  }
  if (plan.mcpServerCount > 0) {
    lines.push(
      `  ${plan.mcpServerCount} MCP server${plan.mcpServerCount === 1 ? '' : 's'}`,
    )
  }
  lines.push(
    '',
    'Will NOT copy credentials or session history — sign in again with /login.',
    `${plan.sourceDir} is left untouched.`,
    `Target global config: ${occGlobalConfigFile()}`,
  )
  return lines.join('\n')
}
