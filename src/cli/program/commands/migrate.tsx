// Extracted verbatim from the former `run()` in src/main.tsx (S7-4b split).
import type { Command as CommanderCommand } from '@commander-js/extra-typings';

export function registerMigrateCommand(program: CommanderCommand): void {
  // Migrate an existing official Claude Code setup into ~/.occ.
  program
    .command('migrate')
    .description(
      "Copy settings, skills, agents, commands, plugins and MCP servers from an existing Claude Code setup (~/.claude) into open-claude-code's own config directory. Credentials are stripped unless you pass --with-credentials; session history is never copied, and ~/.claude is left untouched.",
    )
    .option('--dry-run', 'Show what would be copied without copying anything')
    .option('--force', 'Run again even if a migration already completed')
    .option(
      '--with-credentials',
      'Also copy your Claude Code login (OAuth token / API key) and the API keys in settings.env, so open-claude-code works without a fresh /login. Both CLIs then share one rotating refresh token — expect to sign in again on whichever you use less.',
    )
    .option(
      '--skip-account-data',
      'Deprecated alias for the default credential-free mode. Plugins, skills and MCP servers now migrate either way, with their secrets stripped.',
    )
    // Registered so `--no-account-data` means the same thing here as on the
    // cli.tsx fast path, which has accepted both spellings since 2.9. Commander
    // maps it to `accountData: false` and defaults the field to true.
    .option('--no-account-data', 'Deprecated alias for --skip-account-data.')
    .action(
      async (options: {
        dryRun?: boolean;
        force?: boolean;
        withCredentials?: boolean;
        skipAccountData?: boolean;
        accountData?: boolean;
      }) => {
        // Normally unreachable — cli.tsx intercepts `migrate` before bootstrap.
        // Kept so the command appears in --help, and as a fallback if the fast
        // path is ever bypassed. Same arrangement as `autonomy`.
        const { runMigrate } = await import('src/cli/handlers/migrate.js');
        const optedOut = options.skipAccountData === true || options.accountData === false;
        const code = await runMigrate({
          dryRun: options.dryRun === true,
          force: options.force === true,
          withCredentials: options.withCredentials === true && !optedOut,
        });
        // Explicit exit: this process holds telemetry/MCP handles and will not
        // terminate on its own.
        process.exit(code);
      },
    );
}
