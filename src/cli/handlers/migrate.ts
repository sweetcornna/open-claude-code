/**
 * `occ migrate` — copy an existing Claude Code setup into occ's config dir.
 *
 * This runs from a fast path in `src/entrypoints/cli.tsx`, BEFORE the normal
 * bootstrap. That ordering is deliberate and load-bearing: someone running
 * `migrate` has no occ configuration yet, so the usual startup would put the
 * trust dialog and onboarding in front of them before the command could run.
 * It is also registered in main.tsx so it shows up in `--help`, the same
 * arrangement `autonomy` uses.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import {
  describeMigrationPlan,
  executeMigration,
  type FsProbe,
  planMigrationFromClaude,
} from '../../config/migrateFromClaude.js'

export type MigrateOptions = {
  dryRun: boolean
  force: boolean
}

export function parseMigrateArgs(args: string[]): MigrateOptions {
  return {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
  }
}

const realFsProbe: FsProbe = {
  exists: path => existsSync(path),
  isDirectory: path => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  },
  readFile: path => readFileSync(path, 'utf8'),
}

/**
 * Returns the process exit code. Prints its own output.
 */
export async function runMigrate(
  options: MigrateOptions,
  fs: FsProbe = realFsProbe,
): Promise<number> {
  const plan = planMigrationFromClaude(fs, { force: options.force })
  if (options.force) {
    // describeMigrationPlan() would otherwise report "already migrated" and
    // hide the item list the forced run is about to copy.
    plan.alreadyMigrated = false
  }

  console.log(describeMigrationPlan(plan))

  if (options.dryRun) return 0
  if (plan.items.length === 0 && plan.mcpServerCount === 0) return 0

  const result = await executeMigration(plan)
  console.log(
    `\nCopied: ${result.copied.join(', ') || 'nothing'}${
      result.mcpServersImported > 0
        ? `\nImported ${result.mcpServersImported} MCP server(s)`
        : ''
    }`,
  )
  for (const error of result.errors) {
    console.error(`  failed: ${error}`)
  }
  if (result.errors.length > 0) {
    console.error(
      'Some items could not be copied. Fix the permissions and re-run `occ migrate --force`.',
    )
    return 1
  }
  return 0
}
