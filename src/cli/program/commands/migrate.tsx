// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import type { Command as CommanderCommand } from '@commander-js/extra-typings';

export function registerMigrateCommand(program: CommanderCommand): void {
  // Migrate an existing official Claude Code setup into ~/.occ.
  program
    .command('migrate')
    .description(
      "Copy settings, skills, agents, commands, plugins and MCP servers from an existing Claude Code setup (~/.claude) into open-claude-code's own config directory. Credentials and session history are never copied, and ~/.claude is left untouched.",
    )
    .option('--dry-run', 'Show what would be copied without copying anything')
    .option('--force', 'Run again even if a migration already completed')
    .action(async (options: { dryRun?: boolean; force?: boolean }) => {
      // Normally unreachable — cli.tsx intercepts `migrate` before bootstrap.
      // Kept so the command appears in --help, and as a fallback if the fast
      // path is ever bypassed. Same arrangement as `autonomy`.
      const { runMigrate } = await import('src/cli/handlers/migrate.js');
      const code = await runMigrate({
        dryRun: options.dryRun === true,
        force: options.force === true,
      });
      // Explicit exit: this process holds telemetry/MCP handles and will not
      // terminate on its own.
      process.exit(code);
    });
}
