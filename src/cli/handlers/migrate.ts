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
  planHasWork,
  planMigrationFromClaude,
} from '../../config/migrateFromClaude.js'

export type MigrateOptions = {
  dryRun: boolean
  force: boolean
  /**
   * Bring the OAuth token / API key across too. Off by default: copying a
   * login is the one part of a migration that changes what the OTHER CLI
   * experiences (both ends share a rotating refresh token), so it is opt-in.
   */
  withCredentials: boolean
}

export function parseMigrateArgs(args: string[]): MigrateOptions {
  return {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    // `--skip-account-data` / `--no-account-data` are the pre-2.9 spellings.
    // They used to exclude plugins, skills and MCP servers wholesale; those now
    // migrate in both modes with their secrets stripped, so the flags survive
    // only as an explicit way to ask for the (already default) credential-free
    // mode, and they lose to nothing because they cannot be combined with
    // --with-credentials.
    withCredentials:
      args.includes('--with-credentials') &&
      !args.includes('--skip-account-data') &&
      !args.includes('--no-account-data'),
  }
}

/** Real-filesystem probe. Exported so the onboarding migration step can reuse it. */
export const realFsProbe: FsProbe = {
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
  const plan = planMigrationFromClaude(fs, {
    force: options.force,
    migrateCredentials: options.withCredentials,
  })

  console.log(describeMigrationPlan(plan))

  if (options.dryRun) return 0
  if (!planHasWork(plan)) return 0

  const result = await executeMigration(plan)
  // Suppressed on a credentials-only top-up, where "Copied: nothing" would
  // read as a failure rather than as "there were no files left to copy".
  if (result.copied.length > 0 || result.mcpServersImported > 0) {
    console.log(
      `\nCopied: ${result.copied.join(', ') || 'nothing'}${
        result.mcpServersImported > 0
          ? `\nImported ${result.mcpServersImported} MCP server(s)`
          : ''
      }`,
    )
  } else {
    console.log('')
  }
  for (const note of result.notes) {
    console.log(`  ${note}`)
  }
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
