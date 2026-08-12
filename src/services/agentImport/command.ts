/**
 * `occ import` — bring configuration across from another AI coding agent.
 *
 * This module is the entry point: the one implementation both `occ import` and
 * `/import` run. Keeping the surfaces this thin is deliberate: the CLI and the
 * slash command differ only in how much they trust the caller, and that
 * difference is a single boolean (`requireDigest`) rather than two parallel
 * code paths that can drift apart on which guard they apply.
 *
 * THE DESIGN IN ONE PARAGRAPH
 *
 * occ SCANS the foreign agent's config files with fixed, hand-written readers,
 * turns what it finds into typed items with a content hash, shows that list,
 * and applies only what the caller confirms against that hash. The model never
 * reads `~/.codex` or `~/.gemini`, nothing from those files is ever executed or
 * evaluated, names are sanitised before they become filenames, paths are
 * re-checked after symlink resolution, credentials are stripped by the same
 * rule `occ migrate` uses, and no write ever overwrites an existing file or MCP
 * server.
 *
 * See `safety.ts` for the guards, `codex.ts` / `gemini.ts` for the two scan
 * surfaces and the deliberate divergences from the official importer, and
 * `digest.ts` for why a confirm carries a hash.
 *
 * There is deliberately no barrel: the two surfaces import from here, and
 * everything else is internal to this directory.
 */

import { SCAN_DIGEST_PATTERN, scanDigest } from './digest.js'
import { applyScan, renderScanReport } from './report.js'
import {
  IMPORT_SOURCE_IDS,
  scanAgentConfigs,
  type ScanOptions,
} from './scan.js'

type ImportArgs = {
  source?: string
  dryRun: boolean
  /** `--yes` was present in any form. */
  confirm: boolean
  /** The value of `--yes=<digest>`, if one was given. */
  digest?: string
  /** Arguments that were not recognised, so the surface can complain. */
  unrecognised: string[]
}

const KNOWN_FLAGS = new Set(['--dry-run', '--yes'])

/** Parse the argument string shared by both surfaces. */
export function parseImportArgs(argv: readonly string[]): ImportArgs {
  const args: ImportArgs = { dryRun: false, confirm: false, unrecognised: [] }
  for (const token of argv) {
    if (token === '') continue
    if (token === '--dry-run') {
      args.dryRun = true
      continue
    }
    if (token === '--yes') {
      args.confirm = true
      continue
    }
    if (token.startsWith('--yes=')) {
      args.confirm = true
      args.digest = token.slice('--yes='.length)
      continue
    }
    if (token.startsWith('-') && !KNOWN_FLAGS.has(token)) {
      args.unrecognised.push(token)
      continue
    }
    if (args.source === undefined) {
      args.source = token
      continue
    }
    args.unrecognised.push(token)
  }
  return args
}

type ImportRunResult = {
  text: string
  /** Process exit code for the CLI surface. */
  exitCode: number
}

type RunImportOptions = {
  /**
   * How the caller should be spelled in the follow-up instructions, e.g.
   * `occ import` or `/import codex`.
   */
  invocation: string
  /**
   * Require `--yes=<digest>` rather than a bare `--yes`.
   *
   * True on the slash-command surface, where the confirm may be issued by the
   * model rather than typed by the user: binding the confirm to the digest of
   * the preview means a model cannot apply a list nobody saw, and cannot apply
   * a list that changed since it was shown.
   */
  requireDigest: boolean
  scan?: ScanOptions
}

export async function runAgentImport(
  args: ImportArgs,
  options: RunImportOptions,
): Promise<ImportRunResult> {
  if (args.unrecognised.length > 0) {
    return {
      text: `Unrecognised argument${args.unrecognised.length > 1 ? 's' : ''}: ${args.unrecognised.join(', ')}. Usage: ${options.invocation} [${IMPORT_SOURCE_IDS.join('|')}] [--dry-run] [--yes[=<digest>]]`,
      exitCode: 2,
    }
  }

  const scan = await scanAgentConfigs({ ...options.scan, from: args.source })
  if (scan.error) return { text: scan.error, exitCode: 2 }
  if (scan.scans.length === 0) {
    return { text: renderScanReport(scan, options.invocation), exitCode: 0 }
  }

  if (!args.confirm) {
    return { text: renderScanReport(scan, options.invocation), exitCode: 0 }
  }

  const current = scanDigest(scan.scans)
  if (args.digest !== undefined) {
    if (!SCAN_DIGEST_PATTERN.test(args.digest)) {
      return {
        text: `\`--yes\` needs the scan digest from the preview so the confirm is bound to what was shown. Run \`${options.invocation}\` first to see it.`,
        exitCode: 2,
      }
    }
    if (args.digest !== current) {
      return {
        text: `Refusing: the config on disk no longer matches the preview that digest came from (given \`${args.digest}\`, current scan is \`${current}\`). Run \`${options.invocation}\` again to see what changed, then confirm with the new digest.`,
        exitCode: 2,
      }
    }
  } else if (options.requireDigest) {
    return {
      text: `\`--yes\` needs the scan digest from the preview so the confirm is bound to what was shown. Run \`${options.invocation}\` first (without --yes); the reply includes the exact \`${options.invocation} --yes=<digest>\` to confirm with.`,
      exitCode: 2,
    }
  }

  const report = await applyScan(scan, { dryRun: args.dryRun })
  return { text: report.text, exitCode: report.failed > 0 ? 1 : 0 }
}
