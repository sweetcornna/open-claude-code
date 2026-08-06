/**
 * `claude rollback [target]` — roll back to a previous Claude Code version.
 *
 * ANT-only command (USER_TYPE === "ant").
 *
 * Options:
 *   --list      List recent published versions
 *   --dry-run   Show what would be installed without installing
 *   --safe      Roll back to the server-pinned safe version
 */
import { BIN_NAME, NPM_PACKAGE_NAME } from 'src/constants/brand.js'
import {
  isSafeVersionSpec,
  packageManagerSpawnOptions,
} from 'src/utils/process/packageManager.js'

export async function rollback(
  target?: string,
  options?: { list?: boolean; dryRun?: boolean; safe?: boolean },
): Promise<void> {
  if (options?.list) {
    console.log('Recent versions:')
    console.log('  (version listing requires access to the release registry)')
    console.log(`  Use \`${BIN_NAME} update --list\` for available versions.`)
    return
  }

  if (options?.safe) {
    console.log('Safe rollback: would install the server-pinned safe version.')
    if (options.dryRun) {
      console.log('  (dry run — no changes made)')
      return
    }
    console.log('  Safe version pinning requires access to the release API.')
    console.log('  Contact oncall for the current safe version.')
    return
  }

  if (!target) {
    console.error(
      `Usage: ${BIN_NAME} rollback [target]\n\n` +
        'Options:\n' +
        '  -l, --list     List recent published versions\n' +
        '  --dry-run      Show what would be installed\n' +
        '  --safe         Roll back to server-pinned safe version\n\n' +
        'Examples:\n' +
        '  ' +
        BIN_NAME +
        ' rollback 2.1.880\n' +
        '  ' +
        BIN_NAME +
        ' rollback --list\n' +
        '  ' +
        BIN_NAME +
        ' rollback --safe',
    )
    process.exitCode = 1
    return
  }

  console.log(`Rolling back to version ${target}...`)

  if (options?.dryRun) {
    console.log(`  (dry run — would install ${target})`)
    return
  }

  // The spec is interpolated into a command line that cmd.exe parses on
  // Windows, so reject anything that is not a plain version or dist-tag before
  // it gets there.
  if (!isSafeVersionSpec(target)) {
    console.error(
      `Invalid version "${target}". Expected a version or dist-tag, e.g. 2.29.4 or latest.`,
    )
    return
  }

  // Version rollback via npm/bun
  const { spawnSync } = await import('child_process')
  const result = spawnSync(
    'npm',
    ['install', '-g', `${NPM_PACKAGE_NAME}@${target}`],
    // shell on Windows: npm is a .cmd shim there and cannot be spawned directly.
    { stdio: 'inherit', ...packageManagerSpawnOptions() },
  )

  if (result.status !== 0) {
    console.error(`Rollback failed with exit code ${result.status}`)
    process.exitCode = result.status ?? 1
  } else {
    console.log(`Rolled back to ${target} successfully.`)
  }
}
