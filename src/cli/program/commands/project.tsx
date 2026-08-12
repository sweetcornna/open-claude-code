// `occ project` — project-state maintenance. Currently one subcommand.
//
// The handler is behind a dynamic import for the same reason every other
// subcommand's is: this barrel is reached only after the print-mode early
// return, and even then we don't want to pay for the fs/config modules unless
// the command actually runs.
import type { Command as CommanderCommand } from '@commander-js/extra-typings';

export function registerProjectCommands(program: CommanderCommand): void {
  const project = program.command('project').description('Manage occ project state');

  project
    .command('purge [path]')
    .description(
      'Delete all occ state for a project (transcripts, tasks, debug logs, file history, config entry). Defaults to the current directory. Shell snapshots are not project-scoped and are never touched.',
    )
    .option('--dry-run', 'List what would be deleted without deleting anything', () => true)
    .option('-y, --yes', 'Skip the confirmation prompt', () => true)
    .option('--all', 'Purge state for every project (mutually exclusive with [path])', () => true)
    .action(async (path: string | undefined, options: { all?: boolean; dryRun?: boolean; yes?: boolean }) => {
      const { runProjectPurge } = await import('src/cli/handlers/projectPurge.js');
      const exitCode = await runProjectPurge(path, {
        all: Boolean(options.all),
        dryRun: Boolean(options.dryRun),
        yes: Boolean(options.yes),
      });
      process.exit(exitCode);
    });
}
