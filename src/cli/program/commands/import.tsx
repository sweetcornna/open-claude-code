import type { Command as CommanderCommand } from '@commander-js/extra-typings';

/**
 * `occ import [source]` — import configuration from another AI coding agent.
 *
 * Registered here rather than on the pre-bootstrap fast path because the
 * importer writes MCP servers into the global config. The handler is imported
 * dynamically so the scanners and the TOML reader stay off the startup path.
 */
export function registerImportCommand(program: CommanderCommand): void {
  program
    .command('import')
    .argument('[source]', 'Which agent to import from (codex, gemini)')
    .description(
      "Scan another AI coding agent's config (OpenAI Codex, Google Gemini CLI) and import what maps onto open-claude-code: MCP servers, slash commands, subagents and instruction files. Nothing is applied without --yes, existing files and servers are never overwritten, and API keys and other secrets are stripped.",
    )
    .option('--dry-run', 'Show what would be written without writing anything')
    .option(
      '--yes [digest]',
      'Apply the importable items. Pass the scan digest from the preview (--yes=<digest>) to confirm exactly the list you were shown.',
    )
    .action(async (source: string | undefined, options: { dryRun?: boolean; yes?: boolean | string }) => {
      const { runImport } = await import('src/cli/handlers/import.js');
      const code = await runImport({
        source,
        dryRun: options.dryRun === true,
        yes: options.yes ?? false,
      });
      // Explicit exit: this process holds telemetry/MCP handles and will not
      // terminate on its own. Same arrangement as `migrate`.
      process.exit(code);
    });
}
