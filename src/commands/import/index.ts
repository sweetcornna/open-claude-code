import type { Command, LocalCommandResult } from '../../types/command.js'

/**
 * `/import [codex|gemini] [--dry-run] [--yes=<digest>]`
 *
 * The in-session half of `occ import`. Everything it does is the same
 * deterministic scan the CLI runs — see `src/services/agentImport/`.
 *
 * WHY THIS SURFACE REQUIRES `--yes=<digest>` AND THE CLI DOES NOT
 *
 * A slash command can be issued by the model, not only typed by the user. A
 * bare `--yes` here would let a turn apply a list that nobody was shown, and a
 * turn several messages later could apply a list that has since changed on
 * disk. Binding the confirm to the digest of the preview closes both: the
 * digest only exists in the preview output, and it stops matching the moment
 * the foreign config changes.
 *
 * The scan output itself is written to be model-safe — labels come out of
 * someone else's config file, so the report states that they are data and
 * every one of them is passed through the display sanitisers first.
 */
async function callImport(args: string): Promise<LocalCommandResult> {
  const { parseImportArgs, runAgentImport } = await import(
    '../../services/agentImport/command.js'
  )
  const tokens = args.split(/\s+/).filter(Boolean)
  const parsed = parseImportArgs(tokens)
  const result = await runAgentImport(parsed, {
    invocation: `/import${parsed.source ? ` ${parsed.source}` : ''}`,
    requireDigest: true,
  })
  return { type: 'text', value: result.text }
}

const importCommand: Command = {
  type: 'local',
  name: 'import',
  description: 'Import config from another AI coding agent (codex, gemini)',
  isHidden: false,
  isEnabled: () => true,
  supportsNonInteractive: true,
  argumentHint: '[codex|gemini] [--dry-run] [--yes=<digest>]',
  load: async () => ({ call: callImport }),
}

export default importCommand
