/**
 * `occ import [source]` — terminal surface for the agent-config importer.
 *
 * Prints its own output and returns the process exit code, matching
 * `runMigrate`. The deterministic scan, the guards and the apply all live in
 * `src/services/agentImport/`; this file only translates flags.
 *
 * Unlike `occ migrate` there is no pre-bootstrap fast path: import writes MCP
 * servers into the global config, so it has to run after the config system is
 * open. `enableConfigs()` is idempotent and called defensively for the case
 * where this command is reached before the usual bootstrap.
 */

import {
  parseImportArgs,
  runAgentImport,
} from '../../services/agentImport/command.js'

type ImportCommandOptions = {
  source?: string
  dryRun: boolean
  /** True for a bare `--yes`; a string carries the digest from a preview. */
  yes: boolean | string
}

export async function runImport(
  options: ImportCommandOptions,
): Promise<number> {
  const { enableConfigs } = await import('../../utils/config/config.js')
  enableConfigs()

  const argv: string[] = []
  if (options.source) argv.push(options.source)
  if (options.dryRun) argv.push('--dry-run')
  if (typeof options.yes === 'string') argv.push(`--yes=${options.yes}`)
  else if (options.yes) argv.push('--yes')

  const result = await runAgentImport(parseImportArgs(argv), {
    invocation: 'occ import',
    // A human typed this into their own terminal, so a bare `--yes` is a real
    // confirmation. The slash-command surface, where the model can issue the
    // confirm, requires the digest instead.
    requireDigest: false,
  })
  console.log(result.text)
  return result.exitCode
}
